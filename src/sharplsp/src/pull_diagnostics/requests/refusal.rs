//! How a request that cannot be answered is refused: the protocol's own
//! cancellation and retry codes, and a compiler's refusal with its cause.
//! [DIAG-ANALYSIS-CANCELLATION] [DIAG-TRUTH-GUARANTEES]

use lspkit_server::pull::{AnalysisError, PullError};
use lspkit_server::JsonRpcError;
use serde_json::json;

use crate::sidecar::manager::CompilerRefusal;

/// Preserve protocol cancellation and request-error semantics at the adapter boundary.
pub(super) fn rpc_error(error: &anyhow::Error) -> JsonRpcError {
    let interrupted = error.downcast_ref::<Interrupted>();
    tracing::debug!(?interrupted, "Diagnostic request rejected");
    match interrupted {
        Some(Interrupted::Cancelled) => JsonRpcError::new(-32800, "Request cancelled"),
        // Stable compiler-input failures retain their actionable cause. [DIAG-TRUTH-GUARANTEES]
        _ if compiler_inputs_unavailable(error) => JsonRpcError::new(-32603, error.to_string()),
        _ if settled_refusal(error) => refused(error),
        _ if error.downcast_ref::<serde_json::Error>().is_some() => {
            JsonRpcError::new(-32602, "Invalid diagnostic parameters")
        }
        // A preempted lens is retryable exactly like superseded work, and says
        // why it was cancelled. [SHARPLSP-FEATURES-CODE-LENS]
        _ if error.is::<crate::code_lens::LensPreempted>() => {
            JsonRpcError::new(-32802, crate::code_lens::LensPreempted.to_string())
                .with_data(json!({"retriggerRequest": true}))
        }
        _ => JsonRpcError::new(-32802, "Diagnostic snapshot unavailable or superseded")
            .with_data(json!({"retriggerRequest": true})),
    }
}

/// The compiler's own message, when an analysis failed because the compiler
/// answered with an error: not a superseded request, a timeout or a broken
/// transport. The shared store keeps failures as text. [DIAG-TRUTH-GUARANTEES]
fn compiler_refusal(error: &anyhow::Error) -> Option<&str> {
    let Some(PullError::Analysis(AnalysisError(message))) = error.downcast_ref::<PullError>()
    else {
        return None;
    };
    message
        .strip_prefix(crate::diagnostics::DIAGNOSTICS_REQUEST)?
        .strip_prefix(": ")?
        .strip_prefix(CompilerRefusal::PREFIX)
}

/// Unavailable SDK inputs fail a pull loudly, with their actionable cause. [DIAG-TRUTH-GUARANTEES]
fn compiler_inputs_unavailable(error: &anyhow::Error) -> bool {
    compiler_refusal(error)
        .is_some_and(|cause| cause.starts_with("SDK compiler inputs unavailable: "))
}

/// Any other refusal is settled for the current inputs: asking again cannot
/// change the answer until the workspace changes, and that change refreshes.
/// VS Code asked again at once whenever it was told it could, 165,000 times in
/// thirteen minutes for one document outside every project (#527).
/// A refusal while a selected solution still loads is about the inputs being
/// replaced, so it stays retryable.
pub(in crate::pull_diagnostics) fn settled_refusal(error: &anyhow::Error) -> bool {
    compiler_refusal(error).is_some()
        && !compiler_inputs_unavailable(error)
        && !super::super::state::loading()
}

/// Server-cancelled with the compiler's cause and no retrigger: the editor keeps
/// what it showed, never an empty report, and asks again on the next refresh.
fn refused(error: &anyhow::Error) -> JsonRpcError {
    JsonRpcError::new(-32802, error.to_string()).with_data(json!({"retriggerRequest": false}))
}

#[derive(Debug)]
/// Why this query's result cannot be presented as current truth.
pub(super) enum Interrupted {
    /// The client cancelled this request.
    Cancelled,
    /// A source, workspace or configuration mutation superseded its snapshot.
    Superseded,
}
impl std::fmt::Display for Interrupted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("diagnostic request interrupted")
    }
}
impl std::error::Error for Interrupted {}
