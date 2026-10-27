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
