use super::*;

// ── Call Hierarchy Tests (no sidecar) ───────────────────────────────

// When the LSP server has no sidecar (no workspace root given at initialize),
// all call hierarchy requests must return null/empty without crashing.

#[test]
fn test_prepare_call_hierarchy_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
        NoSidecarResult::Null,
        "prepareCallHierarchy",
    );
}

#[test]
fn test_incoming_calls_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "callHierarchy/incomingCalls",
        hierarchy_item_params("Main", 12, (5, 8, 5, 12), (5, 8, 5, 12)),
        NoSidecarResult::Null,
        "incomingCalls",
    );
}

#[test]
fn test_outgoing_calls_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "callHierarchy/outgoingCalls",
        hierarchy_item_params("Main", 12, (5, 8, 5, 12), (5, 8, 5, 12)),
        NoSidecarResult::Null,
        "outgoingCalls",
    );
}

#[test]
fn test_call_hierarchy_all_three_methods_without_sidecar() {
    let code = "
namespace CallHierarchyTest
{
    public class Service
    {
        public void Start() { Run(); }
        public void Run() { Stop(); }
        public void Stop() { }
    }
}
";
    let mut client = open_no_sidecar(code);

    // Prepare on the Start method.
    let prepare = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 21 }
        }),
    );
    assert_eq!(prepare["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(prepare.get("error").is_none(), "prepare must not error");
    assert!(
        prepare["result"].is_null(),
        "prepare without sidecar must return null"
    );

    // Incoming calls on Run.
    let incoming = client.request(
        "callHierarchy/incomingCalls",
        hierarchy_item_params("Run", 6, (6, 8, 6, 11), (6, 8, 6, 11)),
    );
    assert_eq!(incoming["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(incoming.get("error").is_none(), "incoming must not error");
    assert!(
        incoming["result"].is_null(),
        "incomingCalls without sidecar must return null"
    );

    // Outgoing calls on Run.
    let outgoing = client.request(
        "callHierarchy/outgoingCalls",
        hierarchy_item_params("Run", 6, (6, 8, 6, 11), (6, 8, 6, 11)),
    );
    assert_eq!(outgoing["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(outgoing.get("error").is_none(), "outgoing must not error");
    assert!(
        outgoing["result"].is_null(),
        "outgoingCalls without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_prepare_call_hierarchy_complex_class_without_sidecar() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 16, "character": 15 }
        }),
        NoSidecarResult::Null,
        "prepareCallHierarchy",
    );
}

#[test]
fn test_call_hierarchy_repeated_prepare_same_position() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

    // Same position twice — both must return null without crashing.
    let resp1 = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 7, "character": 8 }
        }),
    );
    let resp2 = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 7, "character": 8 }
        }),
    );

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first prepare must not error");
    assert!(
        resp2.get("error").is_none(),
        "second prepare must not error"
    );
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated prepare must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
