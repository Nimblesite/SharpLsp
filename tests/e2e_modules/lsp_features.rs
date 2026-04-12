use super::*;

// ── Tests for call_hierarchy, type_hierarchy, code_actions, code_lens,
//    inlay_hints, and semantic_tokens without sidecar ────────────────

// ── CALL HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_prepare_call_hierarchy_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/prepareCallHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "prepareCallHierarchy without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "prepareCallHierarchy without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_call_hierarchy_incoming_without_sidecar_returns_empty() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "callHierarchy/incomingCalls",
        json!({
            "item": {
                "name": "Main",
                "kind": 12,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 18 },
                    "end": { "line": 5, "character": 22 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 18 },
                    "end": { "line": 5, "character": 22 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "incomingCalls without sidecar must not error: {resp}"
    );
    // Without sidecar returns empty array.
    assert!(
        resp["result"].is_null() || resp["result"].as_array().is_some_and(Vec::is_empty),
        "incomingCalls without sidecar must return null or empty array, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_call_hierarchy_outgoing_without_sidecar_returns_empty() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "callHierarchy/outgoingCalls",
        json!({
            "item": {
                "name": "Main",
                "kind": 12,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 18 },
                    "end": { "line": 5, "character": 22 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 18 },
                    "end": { "line": 5, "character": 22 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "outgoingCalls without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null() || resp["result"].as_array().is_some_and(Vec::is_empty),
        "outgoingCalls without sidecar must return null or empty array, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_call_hierarchy_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];
    assert!(
        !caps["callHierarchyProvider"].is_null(),
        "callHierarchyProvider must be advertised in capabilities"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── TYPE HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_prepare_type_hierarchy_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "prepareTypeHierarchy without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "prepareTypeHierarchy without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_type_hierarchy_supertypes_without_sidecar_returns_empty() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "typeHierarchy/supertypes",
        json!({
            "item": {
                "name": "Program",
                "kind": 5,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 0 },
                    "end": { "line": 10, "character": 1 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 13 },
                    "end": { "line": 5, "character": 20 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "supertypes without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null() || resp["result"].as_array().is_some_and(Vec::is_empty),
        "supertypes without sidecar must be null or empty, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_type_hierarchy_subtypes_without_sidecar_returns_empty() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "typeHierarchy/subtypes",
        json!({
            "item": {
                "name": "Program",
                "kind": 5,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 5, "character": 0 },
                    "end": { "line": 10, "character": 1 }
                },
                "selectionRange": {
                    "start": { "line": 5, "character": 13 },
                    "end": { "line": 5, "character": 20 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "subtypes without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null() || resp["result"].as_array().is_some_and(Vec::is_empty),
        "subtypes without sidecar must be null or empty, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── CODE ACTIONS ──────────────────────────────────────────────────

#[test]
fn test_code_action_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/codeAction",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 5, "character": 0 },
                "end": { "line": 5, "character": 20 }
            },
            "context": { "diagnostics": [] }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "codeAction without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "codeAction without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];
    assert!(
        !caps["codeActionProvider"].is_null(),
        "codeActionProvider must be advertised, got: {}",
        caps["codeActionProvider"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_resolve_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "codeAction/resolve",
        json!({
            "title": "Fix it",
            "kind": "quickfix",
            "data": { "id": 1, "uri": TEST_URI }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "codeAction/resolve without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "codeAction/resolve without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── CODE LENS ────────────────────────────────────────────────────

#[test]
fn test_code_lens_without_sidecar_returns_empty() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "codeLens without sidecar must not error: {resp}"
    );
    // Without sidecar returns empty array.
    let result = &resp["result"];
    assert!(
        result.is_null() || result.as_array().is_some_and(Vec::is_empty),
        "codeLens without sidecar must return null or empty array, got: {result}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_lens_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];
    assert!(
        !caps["codeLensProvider"].is_null(),
        "codeLensProvider must be advertised, got: {}",
        caps["codeLensProvider"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── INLAY HINTS ───────────────────────────────────────────────────

#[test]
fn test_inlay_hints_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/inlayHint",
        json!({
            "textDocument": { "uri": TEST_URI },
            "range": {
                "start": { "line": 0, "character": 0 },
                "end": { "line": 20, "character": 0 }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have id");
    assert!(
        resp.get("error").is_none(),
        "inlayHint without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "inlayHint without sidecar must return null, got: {}",
        resp["result"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_inlay_hints_capabilities_advertised() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let caps = &resp["result"]["capabilities"];
    assert!(
        !caps["inlayHintProvider"].is_null(),
        "inlayHintProvider must be advertised, got: {}",
        caps["inlayHintProvider"]
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_inlay_hints_on_unopened_document_errors() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    // Do NOT open the document — server should error.

    let resp = client.request(
        "textDocument/inlayHint",
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
        resp.get("error").is_some(),
        "inlayHint on unopened document must return an error, got: {resp}"
    );
    let err = &resp["error"];
    assert!(
        err["code"].as_i64().is_some(),
        "error must have numeric code"
    );
    assert!(
        err["message"].as_str().is_some(),
        "error must have message string"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
