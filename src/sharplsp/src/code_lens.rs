//! Code lens handlers (`textDocument/codeLens`).
//!
//! Returns reference counts and implementation counts above types and members.
//! Implements [SHARPLSP-FEATURES-CODE-LENS] and [DIAG-ANALYSIS-CANCELLATION].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::{Message, Request};
use lsp_types::{CodeLens, CodeLensParams, Command, Position, Range};
use lspkit::sidecar::cancellation::RequestCancelled;
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;
use crate::utils::{with_sidecar, SidecarFileReq};

/// Handle `textDocument/codeLens` — returns reference/implementation count lenses.
pub fn handle_code_lens(
    req: Request,
    runtime: &tokio::runtime::Handle,
    sidecar: Option<&Arc<SidecarManager>>,
    cancel: &lspkit_server::CancellationToken,
    sender: &crossbeam_channel::Sender<Message>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: CodeLensParams| {
        let file_path = crate::paths::uri_to_path(params.text_document.uri.as_str())?;
        let items = request_lenses(runtime, sidecar, file_path, cancel).map_err(|error| {
            preempted_or(error, cancel, || {
                crate::target_framework::refresh(sender, "workspace/codeLens/refresh")
            })
        })?;
        debug!(count = items.len(), "code lenses from sidecar");
        let lenses: Vec<CodeLens> = items.iter().map(map_code_lens).collect();
        Ok(serde_json::to_value(lenses)?)
    })
}

/// A lens another document request took the compiler from: the server
/// cancelled it, and asked the client for it again. [SHARPLSP-FEATURES-CODE-LENS]
#[derive(Debug)]
pub struct LensPreempted;

impl std::fmt::Display for LensPreempted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("code lens preempted by another document request")
    }
}

impl std::error::Error for LensPreempted {}

/// `error`, or [`LensPreempted`] once a preempted lens is asked for again: only
/// the client can reissue it, once the compiler is free. The lens's own
/// cancellation is not a preemption, and is never answered with a refresh.
fn preempted_or(
    error: anyhow::Error,
    cancel: &lspkit_server::CancellationToken,
    refresh: impl FnOnce() -> Result<()>,
) -> anyhow::Error {
    if !error.is::<RequestCancelled>() || cancel.is_cancelled() {
        return error;
    }
    if let Err(failure) = refresh() {
        warn!(%failure, "Could not ask the client to request code lenses again");
    }
    LensPreempted.into()
}

/// Decode current compiler lenses without converting cancellation into empty success.
fn request_lenses(
    runtime: &tokio::runtime::Handle,
    sidecar: &SidecarManager,
    file_path: String,
    cancel: &lspkit_server::CancellationToken,
) -> Result<Vec<SidecarCodeLens>> {
    let payload = rmp_serde::to_vec(&SidecarFileReq { file_path })?;
    let bytes = runtime.block_on(sidecar.request_cancellable(
        "textDocument/codeLens",
        payload,
        Some(cancel),
    ))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Convert a sidecar code lens into an LSP `CodeLens`.
fn map_code_lens(item: &SidecarCodeLens) -> CodeLens {
    CodeLens {
        range: Range::new(
            Position::new(item.line, item.character),
            Position::new(item.line, item.character),
        ),
        command: Some(Command {
            title: item.title.clone(),
            command: "editor.action.showReferences".to_string(),
            arguments: None,
        }),
        data: None,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// A single code lens returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarCodeLens {
    /// Line number where the lens is displayed.
    line: u32,
    /// Character offset within the line.
    character: u32,
    /// Human-readable label shown above the symbol.
    title: String,
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use anyhow::anyhow;
    use lspkit::sidecar::cancellation::RequestCancelled;
    use lspkit_server::CancellationToken;

    use super::{preempted_or, LensPreempted};

    /// What `error` became under `cancel`, and how many refreshes it asked for
    /// when each one `succeeds`.
    fn outcome(
        error: anyhow::Error,
        cancel: &CancellationToken,
        succeeds: bool,
    ) -> (anyhow::Error, u32) {
        let asked = Cell::new(0);
        let answered = preempted_or(error, cancel, || {
            asked.set(asked.get() + 1);
            if succeeds {
                Ok(())
            } else {
                Err(anyhow!("the connection is closed"))
            }
        });
        (answered, asked.get())
    }

    #[test]
    fn only_a_preempted_lens_is_answered_as_preempted_and_asked_again() {
        let running = CancellationToken::new();
        let (answered, asked) = outcome(RequestCancelled.into(), &running, true);
        assert!(
            answered.is::<LensPreempted>(),
            "a preemption reads as one: {answered:#}"
        );
        assert_eq!(asked, 1, "and the client is asked for the lens again");
        let (answered, asked) = outcome(RequestCancelled.into(), &running, false);
        assert!(
            answered.is::<LensPreempted>(),
            "a refresh that cannot be sent changes nothing"
        );
        assert_eq!(asked, 1, "it was tried, and only logged");

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let (answered, asked) = outcome(RequestCancelled.into(), &cancelled, true);
        assert!(
            answered.is::<RequestCancelled>(),
            "the client's own cancellation stays its own"
        );
        assert_eq!(asked, 0, "and is never asked again");
        let (answered, asked) = outcome(anyhow!("sidecar error: no project"), &running, true);
        assert_eq!(
            answered.to_string(),
            "sidecar error: no project",
            "a failure stays a failure"
        );
        assert_eq!(asked, 0, "and is never asked again");
    }
}
