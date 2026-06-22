use super::*;
use std::time::Duration;

// ── Full-stack sidecar-handler coverage sweep ─────────────────────────────────
//
// The no-sidecar handler tests cover only the "sidecar unavailable" branches.
// This test warms a real sidecar once, then drives every sidecar-backed handler
// with positions chosen to return NON-EMPTY results, so the response-mapping
// closures (the bulk of `semantic`, `call_hierarchy`, `workspace_symbols`,
// `type_hierarchy`, `signature_help`, `inlay_hints` handlers) actually execute.
// Every handler must answer without a JSON-RPC error and keep the server alive.

fn assert_no_error(resp: &Value, method: &str) {
    assert_eq!(resp["jsonrpc"], "2.0", "{method}: must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "{method} must not error: {resp}"
    );
}

fn first_item(resp: &Value) -> Option<Value> {
    resp["result"].as_array().and_then(|a| a.first()).cloned()
}

#[test]
fn test_full_stack_sidecar_handler_sweep() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Warm up until the sidecar resolves the `Calculator` class declaration.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 13, Duration::from_secs(90));

    // ── Completion after `calc.` (line 43) + resolve the first item ──
    let completion = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 43, "character": 24 }
        }),
    );
    assert_no_error(&completion, "completion");
    let items = if completion["result"].is_array() {
        completion["result"].as_array().cloned()
    } else {
        completion["result"]["items"].as_array().cloned()
    };
    if let Some(item) = items.and_then(|list| list.into_iter().next()) {
        let resolved = client.request("completionItem/resolve", item);
        assert_no_error(&resolved, "completionItem/resolve");
    }

    // ── References + document highlight on the `Name` property (line 12) ──
    let references = client.request(
        "textDocument/references",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 12, "character": 18 },
            "context": { "includeDeclaration": true }
        }),
    );
    assert_no_error(&references, "references");

    let highlight = client.request(
        "textDocument/documentHighlight",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 12, "character": 18 }
        }),
    );
    assert_no_error(&highlight, "documentHighlight");

    // ── Definition / type-definition / declaration on the `calc.Name` usage ──
    for method in [
        "textDocument/definition",
        "textDocument/typeDefinition",
        "textDocument/declaration",
    ] {
        let resp = client.request(
            method,
            json!({
                "textDocument": { "uri": file_uri },
                "position": { "line": 43, "character": 24 }
            }),
        );
        assert_no_error(&resp, method);
    }

    // ── Call hierarchy: prepare on `Name`, then incoming (read inside Run) ──
    let prepare_name = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 12, "character": 18 }
        }),
    );
    assert_no_error(&prepare_name, "prepareCallHierarchy(Name)");
    if let Some(item) = first_item(&prepare_name) {
        let incoming = client.request("callHierarchy/incomingCalls", json!({ "item": item }));
        assert_no_error(&incoming, "incomingCalls");
    }

    // ── Call hierarchy: prepare on `Run`, then outgoing (it constructs+reads) ──
    let prepare_run = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 40, "character": 23 }
        }),
    );
    assert_no_error(&prepare_run, "prepareCallHierarchy(Run)");
    if let Some(item) = first_item(&prepare_run) {
        let outgoing = client.request("callHierarchy/outgoingCalls", json!({ "item": item }));
        assert_no_error(&outgoing, "outgoingCalls");
    }

    // ── Type hierarchy: prepare on `Calculator`, then super/sub-types ──
    let prepare_type = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 3, "character": 13 }
        }),
    );
    assert_no_error(&prepare_type, "prepareTypeHierarchy");
    if let Some(item) = first_item(&prepare_type) {
        let supertypes =
            client.request("typeHierarchy/supertypes", json!({ "item": item.clone() }));
        assert_no_error(&supertypes, "supertypes");
        let subtypes = client.request("typeHierarchy/subtypes", json!({ "item": item }));
        assert_no_error(&subtypes, "subtypes");
    }

    // ── Workspace symbol search ──
    let symbols = client.request("workspace/symbol", json!({ "query": "Calc" }));
    assert_no_error(&symbols, "workspace/symbol");

    // ── Semantic tokens: full, then a delta after an edit, then a range ──
    let full = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": file_uri } }),
    );
    assert_no_error(&full, "semanticTokens/full");
    let previous_result_id = full["result"]["resultId"].as_str().map(String::from);

    client.notify(
        "textDocument/didChange",
        json!({
            "textDocument": { "uri": file_uri, "version": 2 },
            "contentChanges": [ { "text": format!("{source}\n// trailing change\n") } ]
        }),
    );

    if let Some(result_id) = previous_result_id {
        let delta = client.request(
            "textDocument/semanticTokens/full/delta",
            json!({
                "textDocument": { "uri": file_uri },
                "previousResultId": result_id
            }),
        );
        assert_no_error(&delta, "semanticTokens/full/delta");
    }

    let range = client.request(
        "textDocument/semanticTokens/range",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 18, "character": 0 }
            }
        }),
    );
    assert_no_error(&range, "semanticTokens/range");

    // ── Signature help inside `new Calculator(` (line 42) ──
    let signature = client.request(
        "textDocument/signatureHelp",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 42, "character": 34 }
        }),
    );
    assert_no_error(&signature, "signatureHelp");

    // ── Inlay hints across the file ──
    let inlay = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 45, "character": 0 }
            }
        }),
    );
    assert_no_error(&inlay, "inlayHint");

    // ── Code actions over the `var calc = new Calculator();` line, then resolve ──
    let code_actions = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 42, "character": 8 },
                "end": { "line": 42, "character": 35 }
            },
            "context": { "diagnostics": [] }
        }),
    );
    assert_no_error(&code_actions, "codeAction");
    if let Some(action) = first_item(&code_actions) {
        let resolved = client.request("codeAction/resolve", action);
        assert_no_error(&resolved, "codeAction/resolve");
    }

    // ── Prepare-rename + rename on the local `name` (line 43) ──
    let prepare_rename = client.request(
        "textDocument/prepareRename",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 43, "character": 12 }
        }),
    );
    assert_no_error(&prepare_rename, "prepareRename");

    let rename = client.request(
        "textDocument/rename",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 43, "character": 12 },
            "newName": "renamedLocal"
        }),
    );
    assert_no_error(&rename, "rename");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
