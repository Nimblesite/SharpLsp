//! Bounded notification waits for suites that collect `publishDiagnostics` —
//! an extension of the shared [`LspClient`] harness, included only by the
//! suites that need it, so its entry points are never dead code elsewhere.

#![expect(
    clippy::panic,
    reason = "test code — a missing notification fails the test"
)]
#![expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::indexing_slicing,
    reason = "test code — JSON indexing panics are acceptable test failures"
)]

use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::lsp_client::{path_to_file_uri, LspClient};

/// Bounded waits and document opening on the shared client.
pub(super) trait WaitingClient {
    /// The next notification with `method` whose payload satisfies `keep`,
    /// consuming buffered ones first. Panics after `timeout_secs` without one.
    fn notification(
        &mut self,
        method: &str,
        timeout_secs: u64,
        keep: impl Fn(&Value) -> bool,
    ) -> Value;

    /// Drop every buffered `method` notification: they predate whatever the
    /// caller waits for next, so only later ones can answer it.
    fn discard_buffered(&mut self, method: &str);

    /// Open a document with its current on-disk text.
    fn open_document(&mut self, path: &Path, language_id: &str);
}

impl WaitingClient for LspClient {
    fn discard_buffered(&mut self, method: &str) {
        self.pending
            .retain(|msg| msg.get("method").and_then(Value::as_str) != Some(method));
    }

    fn notification(
        &mut self,
        method: &str,
        timeout_secs: u64,
        keep: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            if let Some(position) = self.pending.iter().position(|msg| {
                msg.get("method").and_then(Value::as_str) == Some(method) && keep(&msg["params"])
            }) {
                return self.pending.remove(position);
            }
            match self.receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(msg) => {
                    if msg.get("method").and_then(Value::as_str) == Some(method)
                        && keep(&msg["params"])
                    {
                        return msg;
                    }
                    if msg.get("id").is_none() {
                        self.pending.push(msg);
                    }
                }
                Err(RecvTimeoutError::Timeout) if Instant::now() > deadline => {
                    let buffered = self
                        .pending
                        .iter()
                        .map(|msg| msg["method"].clone())
                        .collect::<Vec<_>>();
                    panic!(
                        "no {method} notification within {timeout_secs}s; buffered: {buffered:?}"
                    );
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("sharplsp closed its stdout before answering");
                }
            }
        }
    }

    fn open_document(&mut self, path: &Path, language_id: &str) {
        let text = std::fs::read_to_string(path).expect("read opened document");
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": path_to_file_uri(path),
                    "languageId": language_id,
                    "version": 1,
                    "text": text,
                }
            }),
        );
    }
}
