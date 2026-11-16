//! Hover and navigation requests run off the input loop, so an edit or a
//! `$/cancelRequest` reaches the host while the compiler still works on one.
//! A request whose document changed is superseded: its compiler exchange ends
//! and the client is told the content was modified. Implements
//! [SHARPLSP-ARCHITECTURE-ROUTING], [DEFINITION-CACHE], [REFERENCES-SALSA]
//! and [HOVER-CACHING].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
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
