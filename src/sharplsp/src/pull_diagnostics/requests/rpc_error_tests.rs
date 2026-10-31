//! A lens the server preempted is answered as retryable server cancellation,
//! exactly like superseded work, and names its own cause. [SHARPLSP-FEATURES-CODE-LENS]
use serde_json::json;

use super::rpc_error;
use crate::code_lens::LensPreempted;

#[test]
fn a_preempted_lens_is_answered_as_retryable_and_says_why() {
    let lens = rpc_error(&LensPreempted.into());
    assert_eq!(
        lens.code, -32802,
        "the server cancelled it: ServerCancelled"
    );
    assert_eq!(lens.message, LensPreempted.to_string(), "and says why");
    assert_eq!(
        lens.data,
        Some(json!({"retriggerRequest": true})),
        "and it may be asked again at once, like any superseded request"
    );

    let superseded = rpc_error(&anyhow::anyhow!("sidecar error: snapshot moved on"));
    assert_eq!(
        superseded.code, -32802,
        "a superseded pull is cancelled the same way"
    );
    assert_eq!(superseded.data, lens.data, "and is just as retryable");
    assert_ne!(
        superseded.message, lens.message,
        "but only the lens names preemption"
    );
}

/// A pull's analysis failure as the shared store keeps it: the rendered chain.
fn analysis_failure(chain: &str) -> anyhow::Error {
    lspkit_server::pull::PullError::Analysis(lspkit_server::pull::AnalysisError(chain.to_owned()))
        .into()
}

/// A compiler's refusal is settled for the current inputs: answered as
/// server-cancelled, with the compiler's cause and no retrigger, so the editor
/// keeps what it showed and asks again on the next refresh, never at once (#527).
/// [DIAG-TRUTH-GUARANTEES]
#[test]
fn a_compiler_refusal_is_answered_without_a_retrigger() {
    for cause in [
        "The file '/work/Stray.fs' was not part of the project. Did you call InvalidateConfiguration when the list of files in the project changed?",
        "The requested compiler document is not loaded.",
    ] {
        let refused = rpc_error(&analysis_failure(&format!(
            "sidecar diagnostics request: sidecar error: {cause}"
        )));
        assert_eq!(refused.code, -32802, "server-cancelled: {cause}");
        assert_eq!(
            refused.data,
            Some(json!({"retriggerRequest": false})),
            "never asked again at once: {cause}"
        );
        assert!(refused.message.contains(cause), "carries the compiler's cause: {}", refused.message);
    }
}

/// Only the compiler's own answer is settled: unavailable SDK inputs still fail
/// loudly, and a pull the transport or a newer snapshot cut short is still asked
/// again at once. [DIAG-TRUTH-GUARANTEES]
#[test]
fn only_a_compiler_answer_is_settled() {
    let sdk = rpc_error(&analysis_failure(
        "sidecar diagnostics request: sidecar error: SDK compiler inputs unavailable: restore failed",
    ));
    assert_eq!(
        sdk.code, -32603,
        "unavailable SDK inputs are an internal error"
    );
    assert!(
        sdk.message.contains("restore failed"),
        "with their cause: {}",
        sdk.message
    );
    assert_eq!(sdk.data, None, "and no retrigger advice");

    for cut_short in [
        "sidecar diagnostics request: sidecar transport closed",
        "sidecar error: The file was not part of the project.",
        "a different request: sidecar error: refused",
    ] {
        let retried = rpc_error(&analysis_failure(cut_short));
        assert_eq!(retried.code, -32802, "{cut_short}");
        assert_eq!(
            retried.data,
            Some(json!({"retriggerRequest": true})),
            "not a diagnostics refusal, so still retried at once: {cut_short}"
        );
    }
}
