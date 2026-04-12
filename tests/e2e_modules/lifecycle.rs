use super::*;

// 1. LSP LIFECYCLE

#[test]
fn test_initialize_returns_capabilities() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];

    // text document sync
    assert_eq!(caps["textDocumentSync"], 1, "full sync = 1");

    // document symbol
    assert_eq!(caps["documentSymbolProvider"], true);

    // folding range
    assert_eq!(caps["foldingRangeProvider"], true);

    // selection range
    assert_eq!(caps["selectionRangeProvider"], true);

    // linked editing range
    assert_eq!(caps["linkedEditingRangeProvider"], true);

    // definition family
    assert_eq!(caps["definitionProvider"], true);
    assert_eq!(caps["typeDefinitionProvider"], true);
    assert_eq!(caps["declarationProvider"], true);
    assert_eq!(caps["implementationProvider"], true);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_shutdown_and_exit() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Shutdown should return null result.
    let resp = client.request("shutdown", json!(null));
    assert!(resp.get("error").is_none());
    assert_eq!(resp["result"], Value::Null);

    // Exit notification.
    client.notify("exit", json!(null));
    client.wait_with_timeout();
}

#[test]
fn test_request_after_shutdown_returns_error() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Shutdown.
    let _ = client.request("shutdown", json!(null));

    // Any request after shutdown should get InvalidRequest error.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({
            "textDocument": { "uri": TEST_URI }
        }),
    );
    assert!(resp.get("error").is_some(), "expected error after shutdown");
    let error_code = resp["error"]["code"].as_i64().unwrap();
    assert_eq!(error_code, -32600, "InvalidRequest = -32600");

    client.notify("exit", json!(null));
    client.wait_with_timeout();
}

#[test]
fn test_unknown_method_returns_error() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("textDocument/doesNotExist", json!({}));
    assert!(resp.get("error").is_some(), "unknown method should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_unknown_notification_ignored() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send a completely unknown notification.
    client.notify("custom/unknownMethod", json!({"foo": "bar"}));

    // Server should not crash — verify by doing normal work.
    client.open_document(TEST_URI, "public class StillAlive {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "server should still work");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_unsolicited_response_ignored() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send a raw JSON-RPC response (not a request or notification).
    // The server should silently ignore it.
    client.send(&json!({
        "jsonrpc": "2.0",
        "id": 999,
        "result": null
    }));

    // Server should still work.
    client.open_document(TEST_URI, "public class Works {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(
        resp.get("error").is_none(),
        "server should still work after unsolicited response"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_stdin_close_without_exit() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send shutdown but then close stdin WITHOUT sending exit notification.
    let resp = client.request("shutdown", json!(null));
    assert!(resp.get("error").is_none());

    // Drop stdin to close the pipe — the server should exit cleanly.
    let _ = client.stdin.take();
    let result = client
        .child
        .wait_timeout(Duration::from_secs(5))
        .expect("wait failed");
    assert!(result.is_some(), "server should exit when stdin closes");
}
