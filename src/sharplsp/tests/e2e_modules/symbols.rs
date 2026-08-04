use super::*;

// 3. DOCUMENT SYMBOLS

#[test]
fn test_document_symbols_class_with_members() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();

    // Find namespace → class → members.
    let ns = symbols.iter().find(|s| s["name"] == "MyApp").unwrap();
    assert_eq!(ns["kind"], 3, "Namespace = 3");

    let ns_children = ns["children"].as_array().unwrap();
    let class = ns_children.iter().find(|s| s["name"] == "Program").unwrap();
    assert_eq!(class["kind"], 5, "Class = 5");

    let class_children = class["children"].as_array().unwrap();

    // Should have Main method.
    let main = class_children.iter().find(|s| s["name"] == "Main").unwrap();
    assert_eq!(main["kind"], 6, "Method = 6");

    // Should have Name property.
    let name = class_children.iter().find(|s| s["name"] == "Name").unwrap();
    assert_eq!(name["kind"], 7, "Property = 7");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_symbols_complex_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();

    // Find the namespace.
    let ns = symbols
        .iter()
        .find(|s| {
            s["name"]
                .as_str()
                .is_some_and(|n| n.contains("Models") || n.contains("MyApp"))
        })
        .expect("should find namespace");
    let children = ns["children"].as_array().unwrap();

    // Interface.
    let iface = children.iter().find(|s| s["name"] == "IEntity");
    assert!(iface.is_some(), "should find interface IEntity");
    if let Some(i) = iface {
        assert_eq!(i["kind"], 11, "Interface = 11");
    }

    // Class.
    let user = children.iter().find(|s| s["name"] == "User");
    assert!(user.is_some(), "should find class User");

    // Enum.
    let role = children.iter().find(|s| s["name"] == "Role");
    assert!(role.is_some(), "should find enum Role");
    if let Some(r) = role {
        assert_eq!(r["kind"], 10, "Enum = 10");
    }

    // Struct.
    let point = children.iter().find(|s| s["name"] == "Point");
    assert!(point.is_some(), "should find struct Point");
    if let Some(p) = point {
        assert_eq!(p["kind"], 23, "Struct = 23");
    }

    // Record (classified as Class).
    let record = children.iter().find(|s| s["name"] == "PersonRecord");
    assert!(record.is_some(), "should find record PersonRecord");
    if let Some(r) = record {
        assert_eq!(r["kind"], 5, "Record → Class = 5");
    }

    // Delegate.
    let delegate = children.iter().find(|s| s["name"] == "EventHandler");
    assert!(delegate.is_some(), "should find delegate EventHandler");
    if let Some(d) = delegate {
        assert_eq!(d["kind"], 12, "Function/Delegate = 12");
    }

    // Constructor inside User.
    if let Some(u) = user {
        let user_children = u["children"].as_array().unwrap();
        let ctor = user_children.iter().find(|s| s["name"] == "User");
        assert!(ctor.is_some(), "should find constructor User");
        if let Some(c) = ctor {
            assert_eq!(c["kind"], 9, "Constructor = 9");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_symbols_empty_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, EMPTY_FILE);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(symbols.is_empty(), "empty file should have no symbols");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_document_symbols_symbol_ranges() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    // 0-indexed: class is on line 0.
    client.open_document(TEST_URI, "public class Foo\n{\n}\n");

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let sym = &resp["result"][0];
    assert_eq!(sym["name"], "Foo");

    // range should span the whole class declaration.
    let range = &sym["range"];
    assert_eq!(range["start"]["line"], 0);

    // selectionRange should be the name only.
    let sel = &sym["selectionRange"];
    assert_eq!(sel["start"]["line"], 0);
    assert!(
        sel["start"]["character"].as_u64().unwrap() > 0,
        "selection should not start at column 0"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_enum_members_in_symbols() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "public enum Color\n{\n    Red,\n    Green,\n    Blue\n}\n";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    let enum_sym = symbols.iter().find(|s| s["name"] == "Color").unwrap();
    assert_eq!(enum_sym["kind"], 10, "Enum = 10");

    let members = enum_sym["children"].as_array().unwrap();
    let names: Vec<&str> = members.iter().filter_map(|m| m["name"].as_str()).collect();
    assert!(names.contains(&"Red"), "should have Red");
    assert!(names.contains(&"Green"), "should have Green");
    assert!(names.contains(&"Blue"), "should have Blue");

    for m in members {
        assert_eq!(m["kind"], 22, "EnumMember = 22");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_file_scoped_namespace() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "namespace MyApp;\n\npublic class Widget {}\n";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    let ns = symbols.iter().find(|s| s["name"] == "MyApp");
    assert!(ns.is_some(), "should find file-scoped namespace");
    if let Some(n) = ns {
        assert_eq!(n["kind"], 3, "Namespace = 3");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_all_features_on_complex_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, COMPLEX_CLASS);

    // Document symbols.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none());
    assert!(!resp["result"].as_array().unwrap().is_empty());

    // Folding ranges.
    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none());
    assert!(!resp["result"].as_array().unwrap().is_empty());

    // Selection ranges.
    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "positions": [{ "line": 12, "character": 10 }]
        }),
    );
    assert!(resp.get("error").is_none());
    assert!(!resp["result"].as_array().unwrap().is_empty());

    // Linked editing range (no XML in this file).
    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 12, "character": 10 }
        }),
    );
    assert!(resp.get("error").is_none());

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_event_declaration_symbol() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Use event with add/remove accessors.
    let code = "public class Foo\n{\n    public event System.EventHandler OnClick\n    {\n        add { }\n        remove { }\n    }\n}\n";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    let class = symbols.iter().find(|s| s["name"] == "Foo").unwrap();

    // The class should have children (event, field, or both).
    if let Some(children) = class["children"].as_array() {
        let event = children.iter().find(|s| s["name"] == "OnClick");
        assert!(event.is_some(), "should find event OnClick");
        if let Some(e) = event {
            assert_eq!(e["kind"], 24, "Event = 24");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
