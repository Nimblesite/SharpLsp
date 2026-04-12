use super::*;

// ── TYPE HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_full_stack_prepare_type_hierarchy() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet not available");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    // Prepare on ICalculator interface (line 42, char 18).
    let resp = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": file_uri },
            "position": { "line": 42, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "prepareTypeHierarchy must return null or array, got: {result}"
    );
    if let Some(items) = result.as_array() {
        for item in items {
            assert!(item.get("name").is_some(), "item must have name");
            assert!(item.get("kind").is_some(), "item must have kind");
            assert!(item.get("uri").is_some(), "item must have uri");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_type_hierarchy_supertypes() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet not available");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "typeHierarchy/supertypes",
        json!({
            "item": {
                "name": "Calculator",
                "kind": 5,
                "uri": file_uri,
                "range": {
                    "start": { "line": 3, "character": 0 },
                    "end": { "line": 17, "character": 1 }
                },
                "selectionRange": {
                    "start": { "line": 3, "character": 13 },
                    "end": { "line": 3, "character": 23 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "supertypes must be null or array, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_full_stack_type_hierarchy_subtypes() {
    if !is_dotnet_available() {
        eprintln!("SKIPPED: dotnet not available");
        return;
    }

    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));

    let resp = client.request(
        "typeHierarchy/subtypes",
        json!({
            "item": {
                "name": "ICalculator",
                "kind": 11,
                "uri": file_uri,
                "range": {
                    "start": { "line": 42, "character": 0 },
                    "end": { "line": 45, "character": 1 }
                },
                "selectionRange": {
                    "start": { "line": 42, "character": 17 },
                    "end": { "line": 42, "character": 28 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some(),
        "subtypes must be null or array, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
