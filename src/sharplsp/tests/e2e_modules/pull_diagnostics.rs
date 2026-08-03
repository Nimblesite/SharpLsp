use super::*;

// ── Pull Diagnostics (LSP 3.17) ─────────────────────────────────

/// `textDocument/diagnostic` request must return a valid diagnostic report,
/// not "method not found". This is the pull diagnostics model required by
/// VS Code's web client (`code serve-web`).
#[test]
fn test_pull_diagnostics_document_request_is_handled() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/diagnostic",
        json!({
            "textDocument": { "uri": TEST_URI }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "textDocument/diagnostic must not return an error, got: {resp}",
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "textDocument/diagnostic must return a diagnostic report",
    );
    let kind = result["kind"].as_str();
    assert!(
        kind == Some("full") || kind == Some("unchanged"),
        "diagnostic report kind must be 'full' or 'unchanged', got: {kind:?}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `workspace/diagnostic` request must return a valid workspace diagnostic
/// report, not "method not found".
#[test]
fn test_pull_diagnostics_workspace_request_is_handled() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "workspace/diagnostic",
        json!({
            "previousResultIds": []
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "workspace/diagnostic must not return an error, got: {resp}",
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "workspace/diagnostic must return a report",
    );
    assert!(
        result["items"].is_array(),
        "workspace/diagnostic must return items array",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
