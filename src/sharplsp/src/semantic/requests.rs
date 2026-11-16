//! Hover and navigation requests run off the input loop, so an edit or a
//! `$/cancelRequest` reaches the host while the compiler still works on one.
//! A request whose document changed is superseded: its compiler exchange ends
//! and the client is told the content was modified. Implements
//! [SHARPLSP-ARCHITECTURE-ROUTING], [DEFINITION-CACHE], [REFERENCES-SALSA]
//! and [HOVER-CACHING].

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::Result;
use lsp_server::{Message, Request};
use lsp_types::request::{GotoImplementation, References, Request as _};
use lsp_types::ProgressToken;
use lspkit_server::{CancellationToken, HandlerResult, JsonRpcError};
use serde_json::Value;

use super::Route;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::LangId;
use crate::vfs::Vfs;

/// The requests answered here: each names one position of one document.
pub const METHODS: [&str; 7] = [
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/typeDefinition",
    "textDocument/declaration",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/documentHighlight",
];

/// The most locations one partial result carries. [REFERENCES-PERFORMANCE]
const PARTIAL_CHUNK: usize = 200;

/// Sends one partial result of the request being answered; fails once the
/// request was cancelled or superseded.
pub type Partial<'a> = &'a dyn Fn(&ProgressToken, &Value) -> Result<()>;

/// LSP `ContentModified`: the document changed under the request.
const CONTENT_MODIFIED: i32 = -32801;
/// What the shared dispatcher answers a superseded request with.
const SUPERSEDED: i32 = -32802;

/// The debounce window in milliseconds (`server.debounce_ms`).
static DEBOUNCE_MS: AtomicU64 = AtomicU64::new(150);
/// When a document last changed.
static LAST_EDIT: Mutex<Option<Instant>> = Mutex::new(None);

/// How often a request superseded by something other than its own document's
/// change is asked again before it answers `ContentModified` after all. A
/// reload re-arms the file watcher, which reports lost events again, so the
/// attempts are paced: together they wait out about eight seconds.
pub const RETRIES: u32 = 20;

/// The pause before the `attempt`th retry.
pub fn retry_pause(attempt: u32) -> Duration {
    Duration::from_millis(50)
        .saturating_mul(attempt)
        .min(Duration::from_millis(500))
}

/// Orders requests and document changes as the protocol reader saw them.
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
/// Each document's last open, change or close, by its path key.
static CHANGED: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Mutex::default);
/// Each request in flight: when it arrived and the document it asks about.
static ARRIVED: LazyLock<Mutex<HashMap<String, (u64, String)>>> = LazyLock::new(Mutex::default);

/// The next position in the reader's order.
fn next() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::AcqRel)
}

/// The protocol reader saw `request`, which asks about the document `key`.
pub fn arrived(request: &Request, key: &str) {
    let entry = (next(), key.to_owned());
    let mut arrivals = ARRIVED.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = arrivals.insert(request.id.to_string(), entry);
}

/// The protocol reader saw the document `key` open, change or close.
pub fn document_changed(key: &str) {
    let mut changes = CHANGED.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = changes.insert(key.to_owned(), next());
}

/// `request` was answered; it is no longer in flight.
pub fn finished(request: &Request) {
    let mut arrivals = ARRIVED.lock().unwrap_or_else(PoisonError::into_inner);
    let _ = arrivals.remove(&request.id.to_string());
}

/// Whether a superseded request is asked again: its document has not changed
/// since the request arrived, so what superseded it was a lost watcher event
/// or a reload, which every request shares, never an edit of its own.
pub fn asks_again(request: &Request, result: &HandlerResult) -> bool {
    let superseded = matches!(result, HandlerResult::Err(error) if error.code == SUPERSEDED);
    if !superseded || !handles(&request.method) {
        return false;
    }
    let arrivals = ARRIVED.lock().unwrap_or_else(PoisonError::into_inner);
    let Some((arrival, key)) = arrivals.get(&request.id.to_string()) else {
        return false;
    };
    let changes = CHANGED.lock().unwrap_or_else(PoisonError::into_inner);
    changes.get(key).is_none_or(|changed| changed < arrival)
}

/// Whether `method` is answered here.
pub fn handles(method: &str) -> bool {
    METHODS.contains(&method)
}

/// Apply the configured debounce window.
pub fn configure(debounce_ms: u64) {
    DEBOUNCE_MS.store(debounce_ms, Ordering::Release);
}

/// A document changed: requests arriving inside the debounce window wait it
/// out before they reach a compiler.
pub fn edited() {
    *LAST_EDIT.lock().unwrap_or_else(PoisonError::into_inner) = Some(Instant::now());
}

/// What is left of the debounce window since the last edit.
fn remaining() -> Duration {
    let window = Duration::from_millis(DEBOUNCE_MS.load(Ordering::Acquire));
    let last = *LAST_EDIT.lock().unwrap_or_else(PoisonError::into_inner);
    last.map_or(Duration::ZERO, |at| window.saturating_sub(at.elapsed()))
}

/// Wait out the debounce window, and say whether the request is still wanted.
/// While the user types, each keystroke supersedes the requests of the one
/// before, and they end here without a compiler round trip.
fn still_wanted(route: &Route) -> bool {
    let wait = remaining();
    if !wait.is_zero() {
        route.runtime.block_on(async {
            tokio::select! {
                () = route.cancel.cancelled() => {}
                () = tokio::time::sleep(wait) => {}
            }
        });
    }
    !route.cancel.is_cancelled()
}

/// Answer one of [`METHODS`] through the sidecar that owns its document.
/// `engines` is the F# sidecar, then the C# one.
pub fn answer(
    request: Request,
    engines: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Vfs,
    runtime: &tokio::runtime::Handle,
    cancel: &CancellationToken,
    sender: &crossbeam_channel::Sender<Message>,
    partial: Partial<'_>,
) -> Result<Value> {
    let [fsharp, csharp] = engines;
    let token = partial_token(&request);
    let (primary, fallback) = crate::dispatch::pick_sidecar_with_fallback(&request, csharp, fsharp);
    let route = Route {
        runtime: runtime.clone(),
        cancel: cancel.clone(),
        primary: primary.cloned(),
        fallback: fallback.cloned(),
    };
    if !still_wanted(&route) {
        return Ok(Value::Null);
    }
    let uri = crate::dispatch::request_document_uri(&request.params);
    let fsharp_document = uri.as_ref().and_then(LangId::from_uri) == Some(LangId::FSharp);
    if fsharp_document && request.method != GotoImplementation::METHOD {
        crate::cross_language::share_csharp_buffers(route.caller(), fsharp, vfs);
    }
    let value = super::handle(request, vfs, route)?;
    // Before the answer is sent: see `dispatch::handle_request`. [DIAG-PUSH-GATE]
    crate::diagnostic_publish::converge_provisional_publication(
        uri.as_ref(),
        runtime,
        csharp,
        fsharp,
        sender,
    );
    streamed(token.as_ref(), value, partial)
}

/// The token a `textDocument/references` request asks partial results under.
fn partial_token(request: &Request) -> Option<ProgressToken> {
    let token = request.params.get("partialResultToken")?.clone();
    (request.method == References::METHOD)
        .then(|| serde_json::from_value(token).ok())
        .flatten()
}

/// `value`, or an empty result once a large answer went out as partial results
/// of at most [`PARTIAL_CHUNK`] locations each, in order. [REFERENCES-PERFORMANCE]
fn streamed(token: Option<&ProgressToken>, value: Value, partial: Partial<'_>) -> Result<Value> {
    match (token, value) {
        (Some(token), Value::Array(locations)) if locations.len() > PARTIAL_CHUNK => {
            locations
                .chunks(PARTIAL_CHUNK)
                .try_for_each(|chunk| partial(token, &Value::Array(chunk.to_vec())))?;
            Ok(Value::Array(Vec::new()))
        }
        (_, value) => Ok(value),
    }
}

/// A superseded hover or navigation request answers `ContentModified`, which
/// every client drops silently; only diagnostics and code lenses retrigger.
pub fn superseded(method: &str, result: HandlerResult) -> HandlerResult {
    match result {
        HandlerResult::Err(error) if handles(method) && error.code == SUPERSEDED => {
            HandlerResult::Err(JsonRpcError::new(CONTENT_MODIFIED, "Content modified"))
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_superseded_semantic_requests_answer_content_modified() {
        let superseded_error = || HandlerResult::Err(JsonRpcError::new(SUPERSEDED, "superseded"));
        let code = |result: HandlerResult| match result {
            HandlerResult::Err(error) => Some(error.code),
            _ => None,
        };
        for method in METHODS {
            assert!(handles(method));
            assert_eq!(
                code(superseded(method, superseded_error())),
                Some(CONTENT_MODIFIED),
                "{method} drops silently"
            );
            let cancelled = HandlerResult::Err(JsonRpcError::new(-32800, "cancelled"));
            assert_eq!(code(superseded(method, cancelled)), Some(-32800));
        }
        for method in ["textDocument/codeLens", "textDocument/diagnostic"] {
            assert!(!handles(method));
            let kept = superseded(method, superseded_error());
            assert_eq!(code(kept), Some(SUPERSEDED), "{method} still retriggers");
        }
        let answered = superseded("textDocument/hover", HandlerResult::Ok(Value::Null));
        assert!(matches!(answered, HandlerResult::Ok(Value::Null)));
    }

    #[test]
    fn a_request_superseded_by_anything_but_its_own_edit_is_asked_again() {
        let request = |id: i32, method: &str| Request {
            id: id.into(),
            method: method.to_owned(),
            params: Value::Null,
        };
        let superseded_error = || HandlerResult::Err(JsonRpcError::new(SUPERSEDED, "superseded"));
        let (hover, key) = (request(880_001, "textDocument/hover"), "/retry/program.cs");
        assert!(
            !asks_again(&hover, &superseded_error()),
            "unknown until it arrives"
        );
        arrived(&hover, key);
        assert!(
            asks_again(&hover, &superseded_error()),
            "a reload superseded it"
        );
        let cancelled = HandlerResult::Err(JsonRpcError::new(-32800, "cancelled"));
        assert!(!asks_again(&hover, &cancelled), "a cancel is final");
        assert!(!asks_again(&hover, &HandlerResult::Ok(Value::Null)));
        let lens = request(880_002, "textDocument/codeLens");
        arrived(&lens, key);
        assert!(!asks_again(&lens, &superseded_error()), "a lens retriggers");

        // Another document's change is not its own; its own ends it.
        document_changed("/retry/other.cs");
        assert!(asks_again(&hover, &superseded_error()));
        document_changed(key);
        assert!(
            !asks_again(&hover, &superseded_error()),
            "its own edit ends it"
        );
        // A request that arrives after the edit is not ended by it.
        let later = request(880_003, "textDocument/definition");
        arrived(&later, key);
        assert!(asks_again(&later, &superseded_error()));
        finished(&later);
        assert!(
            !asks_again(&later, &superseded_error()),
            "answered requests are forgotten"
        );
        finished(&hover);
        finished(&lens);
    }

    #[test]
    fn retries_are_paced_and_bounded() {
        assert_eq!(retry_pause(1), Duration::from_millis(50));
        assert_eq!(retry_pause(4), Duration::from_millis(200));
        assert_eq!(retry_pause(10), Duration::from_millis(500));
        assert_eq!(retry_pause(RETRIES), Duration::from_millis(500), "capped");
        let total: Duration = (1..=RETRIES).map(retry_pause).sum();
        assert!(total > Duration::from_secs(5) && total < Duration::from_secs(10));
    }

    #[test]
    fn a_large_answer_streams_in_order_and_small_ones_do_not() {
        use std::cell::RefCell;
        let token = ProgressToken::String("refs".to_owned());
        let sent: RefCell<Vec<(ProgressToken, Value)>> = RefCell::new(Vec::new());
        let partial = |token: &ProgressToken, value: &Value| {
            sent.borrow_mut().push((token.clone(), value.clone()));
            Ok(())
        };
        let answer = |count: u32| Value::Array((0..count).map(Value::from).collect());

        let large = streamed(Some(&token), answer(450), &partial).ok();
        assert_eq!(large, Some(serde_json::json!([])), "the response is empty");
        let sizes: Vec<usize> = sent
            .borrow()
            .iter()
            .map(|(_, chunk)| chunk.as_array().map_or(0, Vec::len))
            .collect();
        assert_eq!(sizes, [200, 200, 50]);
        assert!(sent
            .borrow()
            .iter()
            .all(|(sent_under, _)| *sent_under == token));
        let all: Vec<Value> = sent
            .borrow()
            .iter()
            .flat_map(|(_, chunk)| chunk.as_array().cloned().unwrap_or_default())
            .collect();
        assert_eq!(Value::Array(all), answer(450), "every location, in order");

        sent.borrow_mut().clear();
        assert_eq!(
            streamed(Some(&token), answer(200), &partial).ok(),
            Some(answer(200))
        );
        assert_eq!(
            streamed(None, answer(450), &partial).ok(),
            Some(answer(450))
        );
        assert_eq!(
            streamed(Some(&token), Value::Null, &partial).ok(),
            Some(Value::Null)
        );
        assert!(sent.borrow().is_empty(), "nothing else is streamed");

        let ended = |_: &ProgressToken, _: &Value| anyhow::bail!("request cancelled");
        assert!(streamed(Some(&token), answer(450), &ended).is_err());
    }

    #[test]
    fn only_references_ask_for_partial_results() {
        let request = |method: &str, params: Value| Request {
            id: 1.into(),
            method: method.to_owned(),
            params,
        };
        let with_token = serde_json::json!({"partialResultToken": "refs"});
        assert_eq!(
            partial_token(&request("textDocument/references", with_token.clone())),
            Some(ProgressToken::String("refs".to_owned()))
        );
        let numbered = serde_json::json!({"partialResultToken": 7});
        assert_eq!(
            partial_token(&request("textDocument/references", numbered)),
            Some(ProgressToken::Number(7))
        );
        assert_eq!(
            partial_token(&request("textDocument/definition", with_token)),
            None
        );
        let without = serde_json::json!({"textDocument": {"uri": "file:///a.cs"}});
        assert_eq!(
            partial_token(&request("textDocument/references", without)),
            None
        );
    }

    #[test]
    fn the_debounce_window_runs_from_the_last_edit() {
        configure(0);
        edited();
        assert_eq!(remaining(), Duration::ZERO, "a zero window never waits");
        configure(60_000);
        edited();
        let left = remaining();
        assert!(left > Duration::from_secs(59) && left <= Duration::from_secs(60));
        configure(150);
        std::thread::sleep(Duration::from_millis(160));
        assert_eq!(remaining(), Duration::ZERO, "the window has passed");
    }
}
