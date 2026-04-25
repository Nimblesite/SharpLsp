use super::*;

// ── Definition / TypeDefinition / Declaration / Implementation (no sidecar) ──

// 37. DEFINITION ON UNOPENED DOCUMENT

#[test]
fn test_definition_on_unopened_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = definition(&mut client, "file:///ghost/NoFile.cs", 0, 0);
    assert_eq!(resp["jsonrpc"], "2.0");
    let is_err = resp.get("error").is_some();
    let is_null = resp["result"].is_null();
    assert!(is_err || is_null, "must return null or error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 46. DEFINITION ON COMMENT RETURNS NULL (tree-sitter pre-validation)

#[test]
fn test_definition_on_comment_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "// This is a comment\nnamespace Test { public class Foo { } }\n";
    client.open_document(TEST_URI, code);

    let resp = definition(&mut client, TEST_URI, 0, 5);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "definition on comment must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 47. DEFINITION ON STRING LITERAL RETURNS NULL

#[test]
fn test_definition_on_string_literal_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace T\n{\n    public class F\n    {\n        public string X = \"hello\";\n    }\n}\n";
    client.open_document(TEST_URI, code);

    let resp = definition(&mut client, TEST_URI, 4, 28);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "definition on string must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 48. DEFINITION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_definition_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = definition(&mut client, TEST_URI, 5, 18);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "definition without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 49. TYPE DEFINITION ON COMMENT RETURNS NULL

#[test]
fn test_type_definition_on_comment_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "// comment\nnamespace X { }\n";
    client.open_document(TEST_URI, code);

    let resp = type_definition(&mut client, TEST_URI, 0, 3);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "typeDefinition on comment must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 50. DECLARATION ON STRING RETURNS NULL

#[test]
fn test_declaration_on_string_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace T { public class F { public string X = \"abc\"; } }\n";
    client.open_document(TEST_URI, code);

    let resp = declaration(&mut client, TEST_URI, 0, 51);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "declaration on string must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 51. IMPLEMENTATION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_implementation_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp = implementation(&mut client, TEST_URI, 6, 22);
    assert_nav_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "implementation without sidecar must be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
