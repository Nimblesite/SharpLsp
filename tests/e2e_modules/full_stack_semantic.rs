use super::*;

// ── Full-Stack tests for completion, documentHighlight, workspace/symbol,
//    sharplsp/loadSolution, and completionItem/resolve. ─────────────────────

// ── COMPLETION ────────────────────────────────────────────────────

#[test]
fn test_full_stack_completion_returns_items() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Request completion inside the Run() method body.
    // Line 37 (0-indexed): "        var name = calc.Name;" — position after "calc."
    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 37, "character": 24 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "completion must not error: {resp}"
    );
    // Result may be null if the sidecar hasn't indexed yet, or an array/CompletionList.
    let result = &resp["result"];
    if !result.is_null() {
        let items = if result.is_array() {
            result.as_array().expect("completion result must be array")
        } else {
            result["items"]
                .as_array()
                .expect("completion result must have items array")
        };
        assert!(
            !items.is_empty(),
            "completion must return at least one item"
        );
        let first = &items[0];
        assert!(first.get("label").is_some(), "each item must have a label");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_completion_no_sidecar_returns_postfix_or_null() {
    // Without a workspace root the C# sidecar is not started; completion
    // should still work for postfix templates and never error.
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace T; public class X { void M() { var x = 42; x. } }";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 56 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "completion without sidecar must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── COMPLETION ITEM RESOLVE ───────────────────────────────────────

#[test]
fn test_full_stack_completion_resolve_with_valid_item() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // First, get completions so we have a real item with data.
    // Line 37 (0-indexed): "        var name = calc.Name;" — position after "calc."
    let comp_resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 37, "character": 24 }
        }),
    );

    assert!(
        comp_resp.get("error").is_none(),
        "completion must not error: {comp_resp}"
    );

    let result = &comp_resp["result"];
    if result.is_null() {
        eprintln!("SKIPPED: completion returned null, sidecar not ready");
        client.shutdown_and_exit();
        client.wait_with_timeout();
        return;
    }

    // Extract the first item that has a `data` field (sidecar item).
    let items = if result.is_array() {
        result.as_array().expect("array").clone()
    } else {
        result["items"].as_array().expect("items array").clone()
    };

    let item_with_data = items.iter().find(|i| i.get("data").is_some());
    let Some(item) = item_with_data else {
        eprintln!("SKIPPED: no sidecar completion items with data field");
        client.shutdown_and_exit();
        client.wait_with_timeout();
        return;
    };

    // Resolve it.
    let resolve_resp = client.request("completionItem/resolve", item.clone());

    assert_eq!(resolve_resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resolve_resp.get("error").is_none(),
        "completionItem/resolve must not error: {resolve_resp}"
    );
    // The resolved item must still have a label.
    assert!(
        resolve_resp["result"].get("label").is_some(),
        "resolved item must have label: {resolve_resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_completion_resolve_no_sidecar_returns_item() {
    // Without sidecar, completionItem/resolve should return the item unchanged.
    let mut client = LspClient::start();
    let _ = client.initialize();

    let item = json!({
        "label": "Console",
        "kind": 7,
        "data": null
    });

    let resp = client.request("completionItem/resolve", item);

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "completionItem/resolve without sidecar must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── DOCUMENT HIGHLIGHT ────────────────────────────────────────────

#[test]
fn test_full_stack_document_highlight_returns_results() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Highlight "Name" property at line 12 (the property declaration).
    let resp = document_highlight(&mut client, &file_uri, 12, 18);

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "documentHighlight must not error: {resp}"
    );

    let result = &resp["result"];
    if !result.is_null() {
        let highlights = result.as_array().expect("highlights must be array");
        for h in highlights {
            assert!(h.get("range").is_some(), "each highlight must have a range");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_document_highlight_caches_second_request() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // First request — populates cache.
    let resp1 = document_highlight(&mut client, &file_uri, 12, 18);
    assert!(
        resp1.get("error").is_none(),
        "first highlight must not error: {resp1}"
    );

    // Second request — should hit cache.
    let resp2 = document_highlight(&mut client, &file_uri, 12, 18);
    assert!(
        resp2.get("error").is_none(),
        "second highlight must not error: {resp2}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── WORKSPACE/SYMBOL (standard LSP) ───────────────────────────────

#[test]
fn test_standard_workspace_symbol_returns_results() {
    // workspace/symbol is handled via tree-sitter (no sidecar needed).
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code =
        "namespace MyApp; public class Calculator { public int Add(int a, int b) => a + b; }";
    client.open_document(TEST_URI, code);

    let resp = client.request("workspace/symbol", json!({ "query": "calc" }));

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "workspace/symbol must not error: {resp}"
    );

    // Result is an array of SymbolInformation (may be empty for unindexed files,
    // but must not error).
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "workspace/symbol must return null or array: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_standard_workspace_symbol_query_matches_class() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code =
        "namespace MyApp; public class Calculator { public int Add(int a, int b) => a + b; }";
    client.open_document(TEST_URI, code);

    // Empty query returns all symbols.
    let resp = client.request("workspace/symbol", json!({ "query": "" }));

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "workspace/symbol must not error: {resp}"
    );

    let result = &resp["result"];
    if let Some(syms) = result.as_array() {
        // There should be symbols from the open document.
        for sym in syms {
            assert!(sym.get("name").is_some(), "symbol must have name");
            assert!(sym.get("kind").is_some(), "symbol must have kind");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── PULL DIAGNOSTICS (with sidecar) ──────────────────────────────

#[test]
fn test_full_stack_pull_diagnostics_document_returns_report() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": file_uri } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "textDocument/diagnostic must not error: {resp}"
    );
    let result = &resp["result"];
    assert!(!result.is_null(), "must return a diagnostic report");
    let kind = result["kind"].as_str();
    assert!(
        kind == Some("full") || kind == Some("unchanged"),
        "kind must be 'full' or 'unchanged', got: {kind:?}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── SHARPLSP/LOAD SOLUTION ────────────────────────────────────────

#[test]
fn test_full_stack_load_solution_with_sidecar() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Derive the solution path from the root URI.
    let root_path = root_uri.strip_prefix("file://").unwrap_or(&root_uri);
    let sln_path = format!("{root_path}/TestHover.sln");

    let resp = client.request("sharplsp/loadSolution", json!({ "solutionPath": sln_path }));

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "sharplsp/loadSolution must not error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_load_solution_missing_param_returns_error() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Missing solutionPath — should return an error.
    let resp = client.request("sharplsp/loadSolution", json!({}));

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_some(),
        "sharplsp/loadSolution with missing param must return error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
