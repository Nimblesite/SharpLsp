use super::*;

// ── Inlay Hints Tests (no sidecar) ───────────────────────────────────

// Without a sidecar connected, inlay hint requests must return null
// without crashing the server.

#[test]
fn test_inlay_hint_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/inlayHint",
        range_params(0, 0, 20, 0),
        NoSidecarResult::Null,
        "inlayHint",
    );
}

#[test]
fn test_inlay_hint_on_unopened_document_returns_error_or_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Request inlay hints without opening the document first.
    let resp = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": "file:///test/NotOpened.cs" },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 10, "character": 0 }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    // Either an error (document not found) or null result is acceptable.
    let is_error = resp.get("error").is_some();
    let is_null = resp["result"].is_null();
    assert!(
        is_error || is_null,
        "inlayHint on unopened document must error or return null, got: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_inlay_hint_zero_width_range_without_sidecar() {
    assert_no_sidecar_request(
        "public class Calc { public int Add(int a, int b) { return a + b; } }",
        "textDocument/inlayHint",
        range_params(0, 35, 0, 35),
        NoSidecarResult::Null,
        "inlayHint",
    );
}

#[test]
fn test_inlay_hint_complex_class_without_sidecar() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "textDocument/inlayHint",
        range_params(0, 0, 40, 0),
        NoSidecarResult::Null,
        "inlayHint",
    );
}

#[test]
fn test_inlay_hint_after_document_change_without_sidecar() {
    let mut client = open_no_sidecar("public class V1 { public int X; }");

    let before = client.request("textDocument/inlayHint", range_params(0, 0, 1, 0));
    assert!(
        before.get("error").is_none(),
        "before change must not error"
    );
    assert!(before["result"].is_null(), "before must be null");

    // Change the document.
    client.change_document(
        TEST_URI,
        2,
        "public class V2 { public int Add(int a, int b) { return a + b; } }",
    );

    let after = client.request("textDocument/inlayHint", range_params(0, 0, 1, 0));
    assert!(after.get("error").is_none(), "after change must not error");
    assert!(
        after["result"].is_null(),
        "after must be null without sidecar"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_inlay_hint_repeated_same_range_without_sidecar() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

    let params = range_params(5, 0, 12, 0);

    let resp1 = client.request("textDocument/inlayHint", params.clone());
    let resp2 = client.request("textDocument/inlayHint", params);

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first must not error");
    assert!(resp2.get("error").is_none(), "second must not error");
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated inlayHint must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Semantic Tokens Tests (no sidecar) ───────────────────────────────

#[test]
fn test_semantic_tokens_full_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
        NoSidecarResult::Null,
        "semanticTokens/full",
    );
}

#[test]
fn test_semantic_tokens_range_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/semanticTokens/range",
        range_params(0, 0, 15, 0),
        NoSidecarResult::Null,
        "semanticTokens/range",
    );
}

#[test]
fn test_semantic_tokens_full_delta_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/semanticTokens/full/delta",
        json!({
            "textDocument": { "uri": TEST_URI },
            "previousResultId": "1"
        }),
        NoSidecarResult::Null,
        "semanticTokens/full/delta",
    );
}

#[test]
fn test_semantic_tokens_all_three_methods_without_sidecar() {
    let mut client = open_no_sidecar(COMPLEX_CLASS);

    let full = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert_eq!(full["jsonrpc"], "2.0");
    assert!(full.get("error").is_none(), "full must not error");
    assert!(
        full["result"].is_null(),
        "full without sidecar must be null"
    );

    let range = client.request(
        "textDocument/semanticTokens/range",
        range_params(5, 0, 20, 0),
    );
    assert_eq!(range["jsonrpc"], "2.0");
    assert!(range.get("error").is_none(), "range must not error");
    assert!(
        range["result"].is_null(),
        "range without sidecar must be null"
    );

    let delta = client.request(
        "textDocument/semanticTokens/full/delta",
        json!({
            "textDocument": { "uri": TEST_URI },
            "previousResultId": "0"
        }),
    );
    assert_eq!(delta["jsonrpc"], "2.0");
    assert!(delta.get("error").is_none(), "delta must not error");
    assert!(
        delta["result"].is_null(),
        "delta without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_semantic_tokens_full_repeated_without_sidecar() {
    let mut client = open_no_sidecar(SIMPLE_CLASS);

    let resp1 = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let resp2 = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first must not error");
    assert!(resp2.get("error").is_none(), "second must not error");
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated semanticTokens/full must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_semantic_tokens_after_document_change_without_sidecar() {
    let mut client = open_no_sidecar("public class V1 { }");

    let before = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(before.get("error").is_none(), "before must not error");

    client.change_document(TEST_URI, 2, "public class V2 { public void Go() {} }");

    let after = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(after.get("error").is_none(), "after must not error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
