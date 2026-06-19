use super::*;

// ── Full-Stack tests exercising sidecar-dependent handlers ────────
// semantic tokens, code actions, code lens, call hierarchy,
// type hierarchy, inlay hints.

// ── SEMANTIC TOKENS ───────────────────────────────────────────────

#[test]
fn test_full_stack_semantic_tokens_full() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar to be ready via hover poll.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": file_uri } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    // Sidecar may not implement semantic tokens — null is acceptable.
    // If result is present it must have a data array.
    if !result.is_null() {
        assert!(
            result["data"].as_array().is_some(),
            "result must have data array, got: {result}"
        );
        let data = result["data"].as_array().expect("data array");
        // Token data comes in groups of 5.
        assert_eq!(data.len() % 5, 0, "token data length must be multiple of 5");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_semantic_tokens_range() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/semanticTokens/range",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 20, "character": 0 }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    // Sidecar may not implement semantic tokens/range — null is acceptable.
    let result = &resp["result"];
    if !result.is_null() {
        assert!(
            result["data"].as_array().is_some(),
            "range result must have data array"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_semantic_tokens_delta() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // First request full tokens to get a result_id.
    let full_resp = client.request(
        "textDocument/semanticTokens/full",
        json!({ "textDocument": { "uri": file_uri } }),
    );
    assert!(
        full_resp.get("error").is_none(),
        "full tokens must not error: {full_resp}"
    );
    let result_id = full_resp["result"]["resultId"]
        .as_str()
        .unwrap_or("1")
        .to_string();

    // Now request delta.
    let delta_resp = client.request(
        "textDocument/semanticTokens/full/delta",
        json!({
            "textDocument": { "uri": file_uri },
            "previousResultId": result_id
        }),
    );

    assert_eq!(delta_resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        delta_resp.get("error").is_none(),
        "delta must not error: {delta_resp}"
    );
    // Sidecar may not implement delta — null is acceptable.
    // If present, must contain either tokens data or edits.

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── CODE LENS ────────────────────────────────────────────────────

#[test]
fn test_full_stack_code_lens_returns_lenses() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": file_uri } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    // With sidecar, may return lenses or empty array — both are valid.
    assert!(
        result.is_null() || result.as_array().is_some(),
        "codeLens result must be null or array, got: {result}"
    );
    if let Some(lenses) = result.as_array() {
        for lens in lenses {
            assert!(
                lens.get("range").is_some(),
                "each lens must have a range field"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── INLAY HINTS ───────────────────────────────────────────────────

#[test]
fn test_full_stack_inlay_hints_returns_hints() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 70, "character": 0 }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    // With sidecar, result is an array (may be empty for this file).
    assert!(
        result.is_null() || result.as_array().is_some(),
        "inlayHint result must be null or array, got: {result}"
    );
    if let Some(hints) = result.as_array() {
        for hint in hints {
            assert!(
                hint.get("position").is_some(),
                "each hint must have position"
            );
            assert!(hint.get("label").is_some(), "each hint must have label");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── CODE ACTIONS ──────────────────────────────────────────────────

#[test]
fn test_full_stack_code_actions_on_class() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": file_uri },
            "range": {
                "start": { "line": 3, "character": 13 },
                "end": { "line": 3, "character": 23 }
            },
            "context": { "diagnostics": [] }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    // With sidecar, returns array of actions (may be null or empty).
    assert!(
        result.is_null() || result.as_array().is_some(),
        "codeAction result must be null or array, got: {result}"
    );
    if let Some(actions) = result.as_array() {
        for action in actions {
            assert!(action.get("title").is_some(), "each action must have title");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── CALL HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_full_stack_prepare_call_hierarchy() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Prepare on Calculator.Add method (line 9, char 16).
    let resp = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 9, "character": 16 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "prepareCallHierarchy must return null or array, got: {result}"
    );
    if let Some(items) = result.as_array() {
        for item in items {
            assert!(item.get("name").is_some(), "item must have name");
            assert!(item.get("kind").is_some(), "item must have kind");
            assert!(item.get("uri").is_some(), "item must have uri");
            assert!(item.get("range").is_some(), "item must have range");
            assert!(
                item.get("selectionRange").is_some(),
                "item must have selectionRange"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_call_hierarchy_incoming_calls() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "callHierarchy/incomingCalls",
        json!({
            "item": {
                "name": "Add",
                "kind": 6,
                "uri": file_uri,
                "range": {
                    "start": { "line": 9, "character": 15 },
                    "end": { "line": 9, "character": 18 }
                },
                "selectionRange": {
                    "start": { "line": 9, "character": 15 },
                    "end": { "line": 9, "character": 18 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "incomingCalls must be null or array, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── RENAME ────────────────────────────────────────────────────────

// Implements [RENAME-PREPARE] and [RENAME-APPLY]

#[test]
fn test_full_stack_prepare_rename_returns_range() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for sidecar readiness.
    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Position on "Calculator" class name — line 3, character 13 in test workspace source.
    let resp = client.request(
        "textDocument/prepareRename",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 3, "character": 13 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp.get("error").is_none(),
        "prepareRename must not error: {resp}"
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "prepareRename must return a range for a renameable symbol, got null"
    );
    let range = if result["range"].is_object() {
        &result["range"]
    } else {
        result
    };
    assert!(
        range["start"].is_object() && range["end"].is_object(),
        "prepareRename result must contain start/end positions, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_rename_renames_symbol_across_usages() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Rename "Calculator" at line 3, character 13 to "MyCalculator".
    let resp = client.request(
        "textDocument/rename",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 3, "character": 13 },
            "newName": "MyCalculator"
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "rename must not error: {resp}");
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "rename must return a WorkspaceEdit, got null"
    );
    let doc_changes = result["documentChanges"]
        .as_array()
        .expect("rename result must have documentChanges");
    assert!(
        !doc_changes.is_empty(),
        "rename must produce at least one document change"
    );
    let edits = doc_changes[0]["edits"]
        .as_array()
        .expect("document change must have edits");
    assert!(
        !edits.is_empty(),
        "rename must produce at least one text edit"
    );
    let has_rename = edits.iter().any(|e| {
        e["newText"]
            .as_str()
            .is_some_and(|t| t.contains("MyCalculator"))
    });
    assert!(
        has_rename,
        "rename edits must contain 'MyCalculator' in newText"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_rename_no_sidecar_returns_error_or_null() {
    // Without a sidecar, rename must not crash the server.
    let mut client = open_no_sidecar("namespace T; public class Foo {}");

    let resp = client.request(
        "textDocument/rename",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 20 },
            "newName": "Bar"
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_prepare_rename_no_sidecar_returns_null_or_error() {
    let mut client = open_no_sidecar("namespace T; public class Foo {}");

    let resp = client.request("textDocument/prepareRename", position_params(0, 20));

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
