use super::*;

// ── Type Hierarchy Tests (no sidecar) ───────────────────────────────

#[test]
fn test_prepare_type_hierarchy_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Prepare on the User class name.
    let resp = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 11, "character": 18 }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
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
fn test_type_hierarchy_supertypes_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp = client.request(
        "typeHierarchy/supertypes",
        json!({
            "item": {
                "name": "User",
                "kind": 5,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 11, "character": 4 },
                    "end": { "line": 11, "character": 18 }
                },
                "selectionRange": {
                    "start": { "line": 11, "character": 4 },
                    "end": { "line": 11, "character": 18 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "typeHierarchy/supertypes without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "supertypes without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_type_hierarchy_subtypes_without_sidecar_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp = client.request(
        "typeHierarchy/subtypes",
        json!({
            "item": {
                "name": "IEntity",
                "kind": 11,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 7, "character": 4 },
                    "end": { "line": 7, "character": 11 }
                },
                "selectionRange": {
                    "start": { "line": 7, "character": 4 },
                    "end": { "line": 7, "character": 11 }
                }
            }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "must have request id");
    assert!(
        resp.get("error").is_none(),
        "typeHierarchy/subtypes without sidecar must not error: {resp}"
    );
    assert!(
        resp["result"].is_null(),
        "subtypes without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_type_hierarchy_all_three_methods_without_sidecar() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "
namespace TypeHierTest
{
    public interface IShape { double Area(); }
    public abstract class ShapeBase : IShape { public abstract double Area(); }
    public class Circle : ShapeBase { public override double Area() => 3.14; }
    public class Square : ShapeBase { public override double Area() => 4.0; }
}
";
    client.open_document(TEST_URI, code);

    // Prepare on IShape.
    let prepare = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 3, "character": 25 }
        }),
    );
    assert_eq!(prepare["jsonrpc"], "2.0");
    assert!(prepare.get("error").is_none(), "prepare must not error");
    assert!(
        prepare["result"].is_null(),
        "prepare without sidecar must return null"
    );

    // Supertypes of ShapeBase.
    let supertypes = client.request(
        "typeHierarchy/supertypes",
        json!({
            "item": {
                "name": "ShapeBase",
                "kind": 5,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 4, "character": 4 },
                    "end": { "line": 4, "character": 13 }
                },
                "selectionRange": {
                    "start": { "line": 4, "character": 4 },
                    "end": { "line": 4, "character": 13 }
                }
            }
        }),
    );
    assert_eq!(supertypes["jsonrpc"], "2.0");
    assert!(
        supertypes.get("error").is_none(),
        "supertypes must not error"
    );
    assert!(
        supertypes["result"].is_null(),
        "supertypes without sidecar must return null"
    );

    // Subtypes of IShape.
    let subtypes = client.request(
        "typeHierarchy/subtypes",
        json!({
            "item": {
                "name": "IShape",
                "kind": 11,
                "uri": TEST_URI,
                "range": {
                    "start": { "line": 3, "character": 4 },
                    "end": { "line": 3, "character": 10 }
                },
                "selectionRange": {
                    "start": { "line": 3, "character": 4 },
                    "end": { "line": 3, "character": 10 }
                }
            }
        }),
    );
    assert_eq!(subtypes["jsonrpc"], "2.0");
    assert!(subtypes.get("error").is_none(), "subtypes must not error");
    assert!(
        subtypes["result"].is_null(),
        "subtypes without sidecar must return null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_type_hierarchy_prepare_repeated_same_position() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Prepare on IEntity — call twice, must be stable.
    let resp1 = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 7, "character": 22 }
        }),
    );
    let resp2 = client.request(
        "textDocument/prepareTypeHierarchy",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 7, "character": 22 }
        }),
    );

    assert_eq!(resp1["jsonrpc"], "2.0");
    assert_eq!(resp2["jsonrpc"], "2.0");
    assert!(resp1.get("error").is_none(), "first prepare must not error");
    assert!(
        resp2.get("error").is_none(),
        "second prepare must not error"
    );
    assert_eq!(
        resp1["result"], resp2["result"],
        "repeated prepareTypeHierarchy must return same result"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
