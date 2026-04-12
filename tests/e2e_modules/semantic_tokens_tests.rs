use super::*;

// ── SEMANTIC TOKENS ───────────────────────────────────────────────

#[test]
fn test_semantic_tokens_full_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "semanticTokens/full without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "semanticTokens/full without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_semantic_tokens_range_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/semanticTokens/range",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 10, "character": 0 }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "semanticTokens/range without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "semanticTokens/range without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_semantic_tokens_delta_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/semanticTokens/full/delta",
        json!({
            "textDocument": { "uri": TEST_URI },
            "previousResultId": "1"
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "semanticTokens/delta without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "semanticTokens/delta without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_semantic_tokens_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];
    let st = &caps["semanticTokensProvider"];
    assert!(!st.is_null(), "semanticTokensProvider must be advertised");
    assert!(
        !st["legend"].is_null(),
        "semanticTokensProvider must have legend"
    );
    assert!(
        st["legend"]["tokenTypes"].as_array().is_some(),
        "legend must have tokenTypes array"
    );
    assert!(
        !st["legend"]["tokenTypes"]
            .as_array()
            .expect("tokenTypes array")
            .is_empty(),
        "tokenTypes must not be empty"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
