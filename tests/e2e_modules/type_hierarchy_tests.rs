use super::*;

// ── Type Hierarchy Tests (no sidecar) ───────────────────────────────

#[test]
fn test_prepare_type_hierarchy_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "textDocument/prepareTypeHierarchy",
        position_params(11, 18),
        NoSidecarResult::Null,
        "prepareTypeHierarchy",
    );
}

#[test]
fn test_type_hierarchy_supertypes_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "typeHierarchy/supertypes",
        hierarchy_item_params("User", 5, (11, 4, 11, 18), (11, 4, 11, 18)),
        NoSidecarResult::Null,
        "supertypes",
    );
}

#[test]
fn test_type_hierarchy_subtypes_without_sidecar_returns_null() {
    assert_no_sidecar_request(
        COMPLEX_CLASS,
        "typeHierarchy/subtypes",
        hierarchy_item_params("IEntity", 11, (7, 4, 7, 11), (7, 4, 7, 11)),
        NoSidecarResult::Null,
        "subtypes",
    );
}

#[test]
fn test_type_hierarchy_all_three_methods_without_sidecar() {
    let code = "
namespace TypeHierTest
{
    public interface IShape { double Area(); }
    public abstract class ShapeBase : IShape { public abstract double Area(); }
    public class Circle : ShapeBase { public override double Area() => 3.14; }
    public class Square : ShapeBase { public override double Area() => 4.0; }
}
";
    let mut client = open_no_sidecar(code);

    // Prepare on IShape.
    let prepare = client.request("textDocument/prepareTypeHierarchy", position_params(3, 25));
    assert_eq!(prepare["jsonrpc"], "2.0");
    assert!(prepare.get("error").is_none(), "prepare must not error");
    assert!(
        prepare["result"].is_null(),
        "prepare without sidecar must return null"
    );

    // Supertypes of ShapeBase.
    let supertypes = client.request(
        "typeHierarchy/supertypes",
        hierarchy_item_params("ShapeBase", 5, (4, 4, 4, 13), (4, 4, 4, 13)),
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
        hierarchy_item_params("IShape", 11, (3, 4, 3, 10), (3, 4, 3, 10)),
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
    let mut client = open_no_sidecar(COMPLEX_CLASS);

    // Prepare on IEntity — call twice, must be stable.
    let resp1 = client.request("textDocument/prepareTypeHierarchy", position_params(7, 22));
    let resp2 = client.request("textDocument/prepareTypeHierarchy", position_params(7, 22));

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
