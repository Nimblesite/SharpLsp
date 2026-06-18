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
    let code = "// This is a comment\nnamespace Test { public class Foo { } }\n";
    assert_nav_null_no_sidecar(code, definition, 0, 5, "definition on comment must be null");
}

// 47. DEFINITION ON STRING LITERAL RETURNS NULL

#[test]
fn test_definition_on_string_literal_returns_null() {
    let code = "namespace T\n{\n    public class F\n    {\n        public string X = \"hello\";\n    }\n}\n";
    assert_nav_null_no_sidecar(code, definition, 4, 28, "definition on string must be null");
}

// 48. DEFINITION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_definition_without_sidecar_returns_null() {
    assert_nav_null_no_sidecar(
        SIMPLE_CLASS,
        definition,
        5,
        18,
        "definition without sidecar must be null",
    );
}

// 49. TYPE DEFINITION ON COMMENT RETURNS NULL

#[test]
fn test_type_definition_on_comment_returns_null() {
    let code = "// comment\nnamespace X { }\n";
    assert_nav_null_no_sidecar(
        code,
        type_definition,
        0,
        3,
        "typeDefinition on comment must be null",
    );
}

// 50. DECLARATION ON STRING RETURNS NULL

#[test]
fn test_declaration_on_string_returns_null() {
    let code = "namespace T { public class F { public string X = \"abc\"; } }\n";
    assert_nav_null_no_sidecar(
        code,
        declaration,
        0,
        51,
        "declaration on string must be null",
    );
}

// 51. IMPLEMENTATION WITHOUT SIDECAR RETURNS NULL

#[test]
fn test_implementation_without_sidecar_returns_null() {
    assert_nav_null_no_sidecar(
        COMPLEX_CLASS,
        implementation,
        6,
        22,
        "implementation without sidecar must be null",
    );
}
