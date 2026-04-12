use super::*;

// ── Call Hierarchy Tests (no sidecar) ───────────────────────────────

// When the LSP server has no sidecar (no workspace root given at initialize),
// all call hierarchy requests must return null/empty without crashing.

#[test]
fn test_prepare_call_hierarchy_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "prepareCallHierarchy without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "prepareCallHierarchy without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_incoming_calls_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "callHierarchy/incomingCalls",
        json!({
            "item": {
                "name": "Main",
                "kind": 12,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 8 },
                    "end": { "line": 5, "character": 12 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 8 },
                    "end": { "line": 5, "character": 12 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "incomingCalls without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "incomingCalls without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_outgoing_calls_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "callHierarchy/outgoingCalls",
        json!({
            "item": {
                "name": "Main",
                "kind": 12,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 8 },
                    "end": { "line": 5, "character": 12 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 8 },
                    "end": { "line": 5, "character": 12 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "outgoingCalls without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "outgoingCalls without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_call_hierarchy_all_three_methods_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

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
    client.open_document(TEST_URI, code);

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
        json!({
            "item": {
                "name": "Run",
                "kind": 6,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 6, "character": 8 },
                    "end": { "line": 6, "character": 11 }
                },
                "selectionRange": {
                    "start": { "line": 6, "character": 8 },
                    "end": { "line": 6, "character": 11 }
                }
            }
        }),
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
        json!({
            "item": {
                "name": "Run",
                "kind": 6,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 6, "character": 8 },
                    "end": { "line": 6, "character": 11 }
                },
                "selectionRange": {
                    "start": { "line": 6, "character": 8 },
                    "end": { "line": 6, "character": 11 }
                }
            }
        }),
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
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Prepare on the User constructor (line 16).
    let resp = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 16, "character": 15 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "prepareCallHierarchy must not error: {resp}"
    );
    // No sidecar — must return null.
    assert!(
        resp["result"].is_null(),
        "prepareCallHierarchy without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_call_hierarchy_repeated_prepare_same_position() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

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
    assert!(resp2.get("error").is_none(), "second prepare must not error");
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated prepare must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

