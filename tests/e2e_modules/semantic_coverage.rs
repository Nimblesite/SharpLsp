use super::*;

// ── Semantic coverage: definition/nav cache & sidecar-less tests ──

// 65. DEFINITION CACHE RETURNS SAME RESULT ON REPEATED REQUEST

#[test]
fn test_definition_cache_returns_same_result() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    // Without sidecar, definition returns null — cache stores null.
    let resp1 = definition(&mut client, TEST_URI, 5, 18);
    let resp2 = definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp1);
    assert_nav_ok(&resp2);
    assert_eq!(
        resp1["result"], resp2["result"],
        "cached result must equal original"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 66. DEFINITION CACHE INVALIDATED ON DOCUMENT CHANGE

#[test]
fn test_definition_cache_invalidated_on_change() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace T { class F { void M() { } } }\n";
    client.open_document(TEST_URI, code);

    let resp1 = definition(&mut client, TEST_URI, 0, 20);
    assert_nav_ok(&resp1);

    // Change the document — cache must be invalidated.
    client.change_document(TEST_URI, 2, "namespace T { class G { void M() { } } }\n");

    let resp2 = definition(&mut client, TEST_URI, 0, 20);
    assert_nav_ok(&resp2);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 67. TYPE DEFINITION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_type_definition_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = type_definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "typeDefinition without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 68. DECLARATION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_declaration_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = declaration(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "declaration without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 69. TYPE DEFINITION CACHE RETURNS SAME RESULT

#[test]
fn test_type_definition_cache_returns_same_result() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp1 = type_definition(&mut client, TEST_URI, 5, 18);
    let resp2 = type_definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp1);
    assert_nav_ok(&resp2);
    assert_eq!(
        resp1["result"], resp2["result"],
        "typeDefinition cache must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 70. DECLARATION CACHE RETURNS SAME RESULT

#[test]
fn test_declaration_cache_returns_same_result() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp1 = declaration(&mut client, TEST_URI, 5, 18);
    let resp2 = declaration(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp1);
    assert_nav_ok(&resp2);
    assert_eq!(
        resp1["result"], resp2["result"],
        "declaration cache must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 71. IMPLEMENTATION REPEATED RETURNS SAME RESULT

#[test]
fn test_implementation_repeated_returns_same_result() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp1 = implementation(&mut client, TEST_URI, 6, 22);
    let resp2 = implementation(&mut client, TEST_URI, 6, 22);
    assert_nav_ok(&resp1);
    assert_nav_ok(&resp2);
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated implementation must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 72. DEFINITION ON IDENTIFIER WITHOUT SIDECAR — EXERCISES CACHED NAV MISS PATH

#[test]
fn test_definition_on_identifier_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace N { class C { void M() { int x = 1; } } }\n";
    client.open_document(TEST_URI, code);

    // Request on "x" — an identifier, not a comment/string, so it goes
    // through the full cached_nav path.
    let resp = definition(&mut client, TEST_URI, 0, 39);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "definition on local var without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 73. DID_CHANGE TRIGGERS NOTIFY_DID_CHANGE PATH

#[test]
fn test_did_change_then_definition_exercises_notify_path() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code_v1 = "namespace N { class A { void Foo() { } } }\n";
    let code_v2 = "namespace N { class B { void Bar() { } } }\n";

    client.open_document(TEST_URI, code_v1);
    let resp1 = definition(&mut client, TEST_URI, 0, 20);
    assert_nav_ok(&resp1);

    // Change triggers notify_did_change to sidecar (no-op without sidecar,
    // but exercises the code path).
    client.change_document(TEST_URI, 2, code_v2);
    let resp2 = definition(&mut client, TEST_URI, 0, 20);
    assert_nav_ok(&resp2);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 74. TYPE DEFINITION ON IDENTIFIER WITHOUT SIDECAR — EXERCISES SINGLE LOCATION NAV

#[test]
fn test_type_definition_on_identifier_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace N { class C { void M() { int x = 1; } } }\n";
    client.open_document(TEST_URI, code);

    let resp = type_definition(&mut client, TEST_URI, 0, 39);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "typeDefinition on identifier without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 75. DECLARATION ON IDENTIFIER WITHOUT SIDECAR — EXERCISES SINGLE LOCATION NAV

#[test]
fn test_declaration_on_identifier_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace N { class C { void M() { int x = 1; } } }\n";
    client.open_document(TEST_URI, code);

    let resp = declaration(&mut client, TEST_URI, 0, 39);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "declaration on identifier without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 76. ALL NAV METHODS ON SAME POSITION WITHOUT SIDECAR

#[test]
fn test_all_nav_methods_on_same_position_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace N { class C { void M() { var x = new C(); } } }\n";
    client.open_document(TEST_URI, code);

    // Position on "C" in "new C()" — identifier, exercises all four methods.
    let r1 = definition(&mut client, TEST_URI, 0, 49);
    let r2 = type_definition(&mut client, TEST_URI, 0, 49);
    let r3 = declaration(&mut client, TEST_URI, 0, 49);
    let r4 = implementation(&mut client, TEST_URI, 0, 49);

    assert_nav_ok(&r1);
    assert_nav_ok(&r2);
    assert_nav_ok(&r3);
    assert_nav_ok(&r4);

    // All should be null without sidecar.
    assert!(r1["result"].is_null(), "definition must be null");
    assert!(r2["result"].is_null(), "typeDefinition must be null");
    assert!(r3["result"].is_null(), "declaration must be null");
    assert!(r4["result"].is_null(), "implementation must be null");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 77. DEFINITION CACHE DIFFERENT POSITIONS ARE INDEPENDENT

#[test]
fn test_definition_cache_different_positions() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace N\n{\n    class A { }\n    class B { }\n}\n";
    client.open_document(TEST_URI, code);

    // Two different positions — each gets its own cache entry.
    let resp_a = definition(&mut client, TEST_URI, 2, 10);
    let resp_b = definition(&mut client, TEST_URI, 3, 10);
    assert_nav_ok(&resp_a);
    assert_nav_ok(&resp_b);

    // Second request to each position hits cache.
    let cached_a = definition(&mut client, TEST_URI, 2, 10);
    let cached_b = definition(&mut client, TEST_URI, 3, 10);
    assert_nav_ok(&cached_a);
    assert_nav_ok(&cached_b);

    assert_eq!(
        resp_a["result"], cached_a["result"],
        "cache hit for position A"
    );
    assert_eq!(
        resp_b["result"], cached_b["result"],
        "cache hit for position B"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Hover returns null gracefully when no sidecar is connected (no workspace root).

#[test]
fn test_hover_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    // Hover on the class name "Program" (line 5, char 18).
    let resp = hover(&mut client, TEST_URI, 5, 18);
    assert_hover_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "hover without sidecar must return null, got: {}",
        resp["result"],
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// All four navigation methods return null without sidecar in a single session.

#[test]
fn test_all_nav_methods_without_sidecar_return_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    // Definition on class name.
    let resp = definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "definition without sidecar must be null",
    );

    // Type definition on class name.
    let resp = type_definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "typeDefinition without sidecar must be null",
    );

    // Declaration on class name.
    let resp = declaration(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "declaration without sidecar must be null",
    );

    // Implementation on class name.
    let resp = implementation(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "implementation without sidecar must be null",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Completion returns null/empty when no sidecar is connected.

#[test]
fn test_completion_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );
    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "completion without sidecar must not error: {resp}",
    );
    // Without sidecar, result should be null (no completions available).
    assert!(
        resp["result"].is_null(),
        "completion without sidecar must return null, got: {}",
        resp["result"],
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// Completion and hover both return null in a single session without sidecar.

#[test]
fn test_completion_and_hover_without_sidecar_both_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    // Hover first.
    let resp = hover(&mut client, TEST_URI, 5, 18);
    assert_hover_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "hover without sidecar must be null",
    );

    // Then completion.
    let resp = client.request(
        "textDocument/completion",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 5, "character": 18 }
        }),
    );
    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(resp.get("error").is_none(), "completion must not error");
    assert!(
        resp["result"].is_null(),
        "completion without sidecar must be null",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
