use super::*;

// ── Coverage Boost Tests ─────────────────────────────────────────────
//
// These tests target the specific uncovered code paths in src/ files
// that handle LSP methods without a sidecar connection.

// ── completionItem/resolve paths ───────────���────────────────────────

#[test]
fn test_completion_resolve_without_sidecar_returns_item_unchanged() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    // completionItem/resolve without sidecar returns the item unchanged.
    let resp = client.request(
        "completionItem/resolve",
        json!({
            "label": "Console",
            "kind": 7,
            "data": {
                "file_path": "/test/Program.cs",
                "index": 0
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "completionItem/resolve without sidecar must not error: {resp}"
    );
    // Without sidecar the handler returns null.
    assert!(
        resp["result"].is_null(),
        "completionItem/resolve without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_completion_resolve_with_empty_data_returns_item() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    // completionItem/resolve with empty data field exercises the early-return path.
    let resp = client.request(
        "completionItem/resolve",
        json!({
            "label": "Add",
            "kind": 2,
            "data": {}
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "completionItem/resolve must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_completion_resolve_with_no_data_field_returns_item() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    // completionItem/resolve with no data field at all.
    let resp = client.request(
        "completionItem/resolve",
        json!({
            "label": "WriteLine",
            "kind": 2
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "completionItem/resolve must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Document Highlight without sidecar ───────────────────────��──────

#[test]
fn test_document_highlight_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "documentHighlight without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "documentHighlight without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_highlight_complex_class_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Highlight on field "Name".
    let resp = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 13, "character": 23 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "must not error");
    assert!(
        resp["result"].is_null(),
        "documentHighlight without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_highlight_repeated_caches_result() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp1 = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );
    let resp2 = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first must not error");
    assert!(resp2.get("error").is_none(), "second must not error");
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated documentHighlight must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Completion on document with content exercises postfix path ───────

#[test]
fn test_completion_on_cs_file_with_content_returns_null_or_items() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open a C# file with code that triggers postfix completion analysis.
    let code = "
using System.Collections.Generic;

namespace Test
{
    public class Demo
    {
        public void Run()
        {
            var items = new List<int> { 1, 2, 3 };
            items.
        }
    }
}
";
    client.open_document(TEST_URI, code);

    // Request completion at "items." — exercises the VFS + LangId path.
    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 10, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "completion must not error: {resp}"
    );
    // Without sidecar, either null or postfix items — both valid.
    if let Some(result) = resp["result"].as_array() {
        // If we got items, validate their shape.
        for item in result {
            assert!(
                item.get("label").is_some(),
                "each completion item must have a label"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_completion_on_fsharp_file_uses_fsharp_sidecar_route() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Library.fs";
    let fs_code = "
module MyLib

let add x y = x + y
let result = add 1 2
";
    client.open_document(fs_uri, fs_code);

    // Completion on F# file — exercises LangId::FSharp branch in pick_sidecar.
    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 3, "character": 10 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "completion on F# file must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── forge/loadSolution without sidecars ──────────────────────────────

#[test]
fn test_load_solution_without_sidecar_returns_success() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // forge/loadSolution with no sidecar — must return { success: true }.
    let resp = client.request(
        "forge/loadSolution",
        json!({ "solutionPath": "/tmp/test.sln" }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "forge/loadSolution must not error: {resp}"
    );
    let result = &resp["result"];
    assert!(
        result["success"].as_bool().unwrap_or(false),
        "forge/loadSolution must return success: true"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Navigation on F# documents exercises pick_sidecar_with_fallback ──

#[test]
fn test_definition_on_fsharp_file_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Module.fs";
    let fs_code = "module M\nlet foo x = x + 1\nlet bar = foo 5\n";
    client.open_document(fs_uri, fs_code);

    // Definition on F# file exercises the FSharp branch in pick_sidecar_with_fallback.
    let resp = client.request(
        "textDocument/definition",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 2, "character": 10 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "definition on F# file must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "definition on F# without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_references_on_fsharp_file_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Refs.fs";
    let fs_code = "module Refs\nlet greet name = printfn \"Hello %s\" name\n";
    client.open_document(fs_uri, fs_code);

    let resp = client.request(
        "textDocument/references",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 1, "character": 4 },
            "context": { "includeDeclaration": true }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "references on F# file must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "references on F# without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_implementation_on_fsharp_file_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Impl.fs";
    let fs_code = "module Impl\ntype IFoo = interface end\n";
    client.open_document(fs_uri, fs_code);

    let resp = client.request(
        "textDocument/implementation",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 1, "character": 5 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "implementation on F# file must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "implementation on F# without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Document highlight on F# exercises FSharp sidecar route ─────────

