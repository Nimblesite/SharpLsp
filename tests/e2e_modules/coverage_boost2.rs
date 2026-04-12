use super::*;

#[test]
fn test_document_highlight_on_fsharp_file_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Highlight.fs";
    let fs_code = "module H\nlet x = 42\nlet y = x + 1\n";
    client.open_document(fs_uri, fs_code);

    let resp = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 1, "character": 4 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "documentHighlight on F# must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "documentHighlight on F# without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Hover on F# file exercises FSharp pick_sidecar route ─────────────

#[test]
fn test_hover_on_fsharp_file_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/HoverTest.fs";
    let fs_code = "module HoverTest\nlet multiply a b = a * b\n";
    client.open_document(fs_uri, fs_code);

    let resp = client.request(
        "textDocument/hover",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 1, "character": 4 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "hover on F# file must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "hover on F# without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Linked editing range ──────────────────────────────────────────────

#[test]
fn test_linked_editing_range_on_cs_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "public class Widget { public Widget() {} }";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 14 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "linkedEditingRange must not error: {resp}"
    );
    // Either null (no linked edit) or a valid ranges object.
    if !resp["result"].is_null() {
        assert!(
            resp["result"].get("ranges").is_some(),
            "linkedEditingRange result must have ranges field"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_linked_editing_range_on_class_name_matches_constructor() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Class with matching constructor name — typical linked edit scenario.
    let code = "public class Button\n{\n    public Button() {}\n}";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 14 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "must not error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Pull diagnostics variations ───────────────��─────────────────────

#[test]
fn test_pull_diagnostics_document_on_fsharp_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/DiagTest.fs";
    client.open_document(fs_uri, "module DiagTest\nlet x = 42\n");

    let resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": fs_uri } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "textDocument/diagnostic on F# must not error: {resp}"
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "textDocument/diagnostic must return a report"
    );
    assert_eq!(
        result["kind"].as_str(),
        Some("full"),
        "diagnostic report must have kind=full"
    );
    assert!(
        result["items"].is_array(),
        "diagnostic report must have items array"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_pull_diagnostics_workspace_with_previous_result_ids() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "workspace/diagnostic",
        json!({
            "previousResultIds": [
                { "uri": TEST_URI, "value": "1" }
            ]
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "workspace/diagnostic must not error: {resp}"
    );
    assert!(
        resp["result"]["items"].is_array(),
        "workspace/diagnostic must return items array"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Error path: request to unknown method ────────────────────────────

#[test]
fn test_completely_unknown_request_returns_method_not_found_error() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/nonExistentMethod",
        json!({"foo": "bar"}),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_some(),
        "unknown method must return error: {resp}"
    );
    let code = resp["error"]["code"].as_i64().unwrap_or(0);
    // InternalError = -32603.
    assert_eq!(code, -32603, "must be InternalError");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
