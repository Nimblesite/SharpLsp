use super::*;

// ── Code Actions Tests (no sidecar) ─────────────────────────────────

// Without a sidecar, code action requests must return null/empty
// without crashing the server.

#[test]
fn test_code_action_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/codeAction",
        code_action_params(5, 8, 5, 16),
        NoSidecarResult::Null,
        "codeAction",
    );
}

#[test]
fn test_code_action_resolve_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "codeAction/resolve",
        json!({
            "title": "Add missing using",
            "kind": "quickfix",
            "data": { "id": 1, "uri": TEST_URI }
        }),
        NoSidecarResult::Null,
        "codeAction/resolve",
    );
}

#[test]
fn test_code_action_zero_width_range_without_sidecar() {
    // Zero-width range (cursor position, no selection).
    assert_no_sidecar_request(
        "public class Widget { public void Render() { } }",
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
        NoSidecarResult::Null,
        "codeAction",
    );
}

#[test]
fn test_code_action_full_document_range_without_sidecar() {
    // Range spanning the entire document.
    assert_no_sidecar_request(
        COMPLEX_CLASS,
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
        NoSidecarResult::Null,
        "codeAction",
    );
}

#[test]
fn test_code_action_repeated_same_range_without_sidecar() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

    let params = code_action_params(7, 12, 7, 28);

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
    let mut client = open_no_sidecar("public class V1 { }");

    let before = client.request("textDocument/codeAction", code_action_params(0, 13, 0, 15));
    assert!(
        before.get("error").is_none(),
        "before change must not error"
    );

    // Change document.
    client.change_document(TEST_URI, 2, "public class V2 { public void Go() {} }");

    let after = client.request("textDocument/codeAction", code_action_params(0, 13, 0, 15));
    assert!(after.get("error").is_none(), "after change must not error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Code Lens Tests (no sidecar) ─────────────────────────────────────

#[test]
fn test_code_lens_without_sidecar_returns_empty_array() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
        NoSidecarResult::NullOrEmptyArray,
        "codeLens",
    );
}

#[test]
fn test_code_lens_on_complex_class_without_sidecar() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
        NoSidecarResult::NullOrEmptyArray,
        "codeLens",
    );
}

#[test]
fn test_code_lens_repeated_on_same_document_without_sidecar() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

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
    let mut client = open_no_sidecar("public class Before { }");

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
    let mut client = open_no_sidecar(COMPLEX_CLASS);

    // Interleave code lens and code action requests.
    let lens1 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(lens1.get("error").is_none(), "lens1 must not error");

    let action1 = client.request("textDocument/codeAction", code_action_params(5, 4, 5, 14));
    assert!(action1.get("error").is_none(), "action1 must not error");

    let lens2 = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(lens2.get("error").is_none(), "lens2 must not error");

    let action2 = client.request("textDocument/codeAction", code_action_params(11, 8, 11, 20));
    assert!(action2.get("error").is_none(), "action2 must not error");

    // All must be null or empty (no sidecar).
    assert_eq!(
        lens1["result"], lens2["result"],
        "lens results must be equal"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
