//! A lens the server preempted is answered as the server's cancellation of a
//! lens, never as a diagnostic pull to retrigger. [SHARPLSP-FEATURES-CODE-LENS]
use serde_json::json;

use super::rpc_error;
use crate::code_lens::LensPreempted;

#[test]
fn a_preempted_lens_is_answered_without_a_diagnostic_retrigger() {
    let lens = rpc_error(&LensPreempted.into());
    assert_eq!(
        lens.code, -32802,
        "the server cancelled it: ServerCancelled"
    );
    assert_eq!(lens.message, LensPreempted.to_string(), "and says why");
    assert_eq!(lens.data, None, "with no diagnostic retrigger to act on");

    let superseded = rpc_error(&anyhow::anyhow!("sidecar error: snapshot moved on"));
    assert_eq!(
        superseded.code, -32802,
        "a superseded pull is cancelled too"
    );
    assert_eq!(
        superseded.data,
        Some(json!({"retriggerRequest": true})),
        "but it alone asks the client to pull again"
    );
}
