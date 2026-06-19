use super::*;

// ── SEMANTIC TOKENS ───────────────────────────────────────────────

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
        range_params(0, 0, 10, 0),
        NoSidecarResult::Null,
        "semanticTokens/range",
    );
}

#[test]
fn test_semantic_tokens_delta_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/semanticTokens/full/delta",
        json!({
            "textDocument": { "uri": TEST_URI },
            "previousResultId": "1"
        }),
        NoSidecarResult::Null,
        "semanticTokens/delta",
    );
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
