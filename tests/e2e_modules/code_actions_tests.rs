use super::*;

// ── Code Actions Tests (no sidecar) ─────────────────────────────────

// Without a sidecar, code action requests must return null/empty
// without crashing the server.

#[test]
fn test_code_action_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 5, "character": 8 },
                "end": { "line": 5, "character": 16 }
            },
            "context": {
                "diagnostics": []
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "codeAction without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "codeAction without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_resolve_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "codeAction/resolve",
        json!({
            "title": "Add missing using",
            "kind": "quickfix",
            "data": { "id": 1, "uri": TEST_URI }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "codeAction/resolve without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "codeAction/resolve without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_zero_width_range_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "public class Widget { public void Render() { } }";
    client.open_document(TEST_URI, code);

    // Zero-width range (cursor position, no selection).
    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 33 },
                "end": { "line": 0, "character": 33 }
            },
            "context": {
                "diagnostics": [],
                "triggerKind": 1
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "codeAction with zero-width range must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "codeAction without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_full_document_range_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Range spanning the entire document.
    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 50, "character": 0 }
            },
            "context": {
                "diagnostics": [],
                "only": ["quickfix", "refactor"]
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "must not error");
    assert!(
        resp["result"].is_null(),
        "codeAction without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_repeated_same_range_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let params = json!({
        "textDocument": { "uri": TEST_URI },
        "range": {
            "start": { "line": 7, "character": 12 },
            "end": { "line": 7, "character": 28 }
        },
        "context": { "diagnostics": [] }
    });

    let resp1 = client.request("textDocument/codeAction", params.clone());
    let resp2 = client.request("textDocument/codeAction", params);

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first request must not error");
    assert!(
        resp2.get("error").is_none(),
        "second request must not error"
    );
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated codeAction must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_after_document_change_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class V1 { }");

    let before = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 13 },
                "end": { "line": 0, "character": 15 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(
        before.get("error").is_none(),
        "before change must not error"
    );

    // Change document.
    client.change_document(TEST_URI, 2, "public class V2 { public void Go() {} }");

    let after = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 13 },
                "end": { "line": 0, "character": 15 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(after.get("error").is_none(), "after change must not error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Code Lens Tests (no sidecar) ─────────────────────────────────────

#[test]
fn test_code_lens_without_sidecar_returns_empty_array() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "codeLens without sidecar must not error: {resp}"
    );
    // Without sidecar the handler returns an empty array.
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some_and(Vec::is_empty),
        "codeLens without sidecar must return null or empty array, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_lens_on_complex_class_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some_and(Vec::is_empty),
        "codeLens without sidecar must return null or empty array"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_lens_repeated_on_same_document_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp1 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let resp2 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first must not error");
    assert!(resp2.get("error").is_none(), "second must not error");
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated codeLens must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_lens_after_document_change_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class Before { }");

    let before = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(
        before.get("error").is_none(),
        "before change must not error"
    );

    client.change_document(
        TEST_URI,
        2,
        "public class After { public void Method() {} }",
    );

    let after = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(after.get("error").is_none(), "after change must not error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_lens_and_code_action_interleaved_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Interleave code lens and code action requests.
    let lens1 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(lens1.get("error").is_none(), "lens1 must not error");

    let action1 = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 5, "character": 4 },
                "end": { "line": 5, "character": 14 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(action1.get("error").is_none(), "action1 must not error");

    let lens2 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(lens2.get("error").is_none(), "lens2 must not error");

    let action2 = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 11, "character": 8 },
                "end": { "line": 11, "character": 20 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert!(action2.get("error").is_none(), "action2 must not error");

    // All must be null or empty (no sidecar).
    assert_eq!(
        lens1["result"], lens2["result"],
        "lens results must be equal"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
