use super::*;

// ── Tests for call_hierarchy, type_hierarchy, code_actions, code_lens,
//    inlay_hints, and semantic_tokens without sidecar ────────────────

// ── CALL HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_prepare_call_hierarchy_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/prepareCallHierarchy",
        position_params(5, 18),
        NoSidecarResult::Null,
        "prepareCallHierarchy",
    );
}

#[test]
fn test_call_hierarchy_incoming_without_sidecar_returns_empty() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "callHierarchy/incomingCalls",
        hierarchy_item_params("Main", 12, (5, 18, 5, 22), (5, 18, 5, 22)),
        NoSidecarResult::NullOrEmptyArray,
        "incomingCalls",
    );
}

#[test]
fn test_call_hierarchy_outgoing_without_sidecar_returns_empty() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "callHierarchy/outgoingCalls",
        hierarchy_item_params("Main", 12, (5, 18, 5, 22), (5, 18, 5, 22)),
        NoSidecarResult::NullOrEmptyArray,
        "outgoingCalls",
    );
}

#[test]
fn test_call_hierarchy_capabilities_advertised() {
    assert_capability_advertised("callHierarchyProvider", "callHierarchyProvider");
}

// ── TYPE HIERARCHY ────────────────────────────────────────────────

#[test]
fn test_prepare_type_hierarchy_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/prepareTypeHierarchy",
        position_params(5, 18),
        NoSidecarResult::Null,
        "prepareTypeHierarchy",
    );
}

#[test]
fn test_type_hierarchy_supertypes_without_sidecar_returns_empty() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "typeHierarchy/supertypes",
        hierarchy_item_params("Program", 5, (5, 0, 10, 1), (5, 13, 5, 20)),
        NoSidecarResult::NullOrEmptyArray,
        "supertypes",
    );
}

#[test]
fn test_type_hierarchy_subtypes_without_sidecar_returns_empty() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "typeHierarchy/subtypes",
        hierarchy_item_params("Program", 5, (5, 0, 10, 1), (5, 13, 5, 20)),
        NoSidecarResult::NullOrEmptyArray,
        "subtypes",
    );
}

// ── CODE ACTIONS ──────────────────────────────────────────────────

#[test]
fn test_code_action_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/codeAction",
        code_action_params(5, 0, 5, 20),
        NoSidecarResult::Null,
        "codeAction",
    );
}

#[test]
fn test_code_action_capabilities_advertised() {
    assert_capability_advertised("codeActionProvider", "codeActionProvider");
}

// ── COMPLETION ────────────────────────────────────────────────────

// Member-access completion (typing `.`) only auto-fires if the server
// advertises `.` as a completion trigger character. Without it, editors never
// send a textDocument/completion request after a dot, so the popup never
// appears. Regression guard for that bug.
#[test]
fn test_completion_capabilities_advertise_dot_trigger_character() {
    let mut client = LspClient::start();
    let resp = client.initialize();

    let completion_provider = &resp["result"]["capabilities"]["completionProvider"];
    assert!(
        !completion_provider.is_null(),
        "completionProvider must be advertised, got: {completion_provider}"
    );

    let triggers = completion_provider["triggerCharacters"]
        .as_array()
        .expect("completionProvider.triggerCharacters must be advertised");
    assert!(
        triggers.iter().any(|c| c.as_str() == Some(".")),
        "completionProvider.triggerCharacters must include `.` for member-access \
         completion, got: {completion_provider}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_code_action_resolve_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "codeAction/resolve",
        json!({
            "title": "Fix it",
            "kind": "quickfix",
            "data": { "id": 1, "uri": TEST_URI }
        }),
        NoSidecarResult::Null,
        "codeAction/resolve",
    );
}

// ── CODE LENS ────────────────────────────────────────────────────

#[test]
fn test_code_lens_without_sidecar_returns_empty() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/codeLens",
        json!({ "textDocument": { "uri": TEST_URI } }),
        NoSidecarResult::NullOrEmptyArray,
        "codeLens",
    );
}

#[test]
fn test_code_lens_capabilities_advertised() {
    assert_capability_advertised("codeLensProvider", "codeLensProvider");
}

// ── INLAY HINTS ───────────────────────────────────────────────────

#[test]
fn test_inlay_hints_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        SIMPLE_CLASS,
        "textDocument/inlayHint",
        range_params(0, 0, 20, 0),
        NoSidecarResult::Null,
        "inlayHint",
    );
}

#[test]
fn test_inlay_hints_capabilities_advertised() {
    assert_capability_advertised("inlayHintProvider", "inlayHintProvider");
}

#[test]
fn test_inlay_hints_on_unopened_document_errors() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    // Do NOT open the document — server should error.

    let resp = client.request("textDocument/inlayHint", range_params(0, 0, 10, 0));

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
