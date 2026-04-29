use super::*;

// ── Sort Members E2E Tests ───────────────────────────────────────

pub(super) fn create_sort_members_file(content: &str) -> (tempfile::TempDir, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    let real_path = std::fs::canonicalize(tmp.path()).unwrap();
    let file_path = real_path.join("SortTest.cs");
    std::fs::write(&file_path, content).unwrap();
    let file_uri = format!("file://{}", file_path.display());
    (tmp, file_path.to_string_lossy().to_string(), file_uri)
}

pub(super) fn default_sort_config() -> Value {
    json!({
        "hierarchy": ["accessibility", "category", "alphabetical"],
        "accessibilityOrder": [
            "public", "protected internal", "internal",
            "protected", "private protected", "private"
        ],
        "categoryOrder": [
            "constant", "field", "constructor", "finalizer", "delegate",
            "event", "enum", "interface", "property", "indexer",
            "operator", "method", "struct", "class", "record"
        ]
    })
}

// 52. SORT MEMBERS: REORDER BY ACCESSIBILITY

#[test]
fn test_sort_members_reorders_by_accessibility() {
    let source = "namespace Test\n{\n    public class Foo\n    {\n        private void PrivateMethod() { }\n        public void PublicMethod() { }\n        internal void InternalMethod() { }\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 7, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "sharplsp/sortMembers must not error: {resp}",
    );
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected edits to reorder members");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let pub_pos = new_text.find("PublicMethod").expect("PublicMethod");
    let int_pos = new_text.find("InternalMethod").expect("InternalMethod");
    let priv_pos = new_text.find("PrivateMethod").expect("PrivateMethod");
    assert!(
        pub_pos < int_pos && int_pos < priv_pos,
        "expected public < internal < private",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 53. SORT MEMBERS: REORDER BY CATEGORY

#[test]
fn test_sort_members_reorders_by_category() {
    let source = "namespace Test\n{\n    public class Bar\n    {\n        public void DoStuff() { }\n        public int Value { get; set; }\n        public int _field;\n        public Bar() { }\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 8, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let field_pos = new_text.find("_field").expect("_field");
    let ctor_pos = new_text.find("Bar()").expect("Bar()");
    let prop_pos = new_text.find("Value").expect("Value");
    let method_pos = new_text.find("DoStuff").expect("DoStuff");
    assert!(
        field_pos < ctor_pos && ctor_pos < prop_pos && prop_pos < method_pos,
        "expected field < ctor < property < method",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 54. SORT MEMBERS: ALREADY SORTED RETURNS NO EDITS

#[test]
fn test_sort_members_already_sorted_returns_no_edits() {
    let source = "namespace Test\n{\n    public class Sorted\n    {\n        public int Alpha;\n        public int Beta;\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 6, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(edits.is_empty(), "already sorted — expected no edits");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 55. SORT MEMBERS: SINGLE MEMBER RETURNS NO EDITS

#[test]
fn test_sort_members_single_member_returns_no_edits() {
    let source = "namespace Test\n{\n    public class OneMember\n    {\n        public void Only() { }\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 5, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(edits.is_empty(), "single member — no sorting needed");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 56. SORT MEMBERS: CUSTOM HIERARCHY (CATEGORY FIRST)

#[test]
fn test_sort_members_custom_hierarchy_category_first() {
    let source = "namespace Test\n{\n    public class Custom\n    {\n        public void PublicMethod() { }\n        private int _privateField;\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 6, "character": 5 }
            },
            "sortConfig": {
                "hierarchy": ["category", "accessibility", "alphabetical"],
                "accessibilityOrder": ["public", "private"],
                "categoryOrder": ["field", "method"]
            }
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let field_pos = new_text.find("_privateField").expect("field");
    let method_pos = new_text.find("PublicMethod").expect("method");
    assert!(
        field_pos < method_pos,
        "category-first: field before method regardless of access",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 57. SORT MEMBERS: INTERFACE SORTS METHODS ALPHABETICALLY

#[test]
fn test_sort_members_interface_sorts_methods() {
    let source = "namespace Test\n{\n    public interface IService\n    {\n        void Zebra();\n        void Alpha();\n        void Middle();\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 7, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let alpha_pos = new_text.find("Alpha").expect("Alpha");
    let middle_pos = new_text.find("Middle").expect("Middle");
    let zebra_pos = new_text.find("Zebra").expect("Zebra");
    assert!(
        alpha_pos < middle_pos && middle_pos < zebra_pos,
        "expected alphabetical order",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 58. SORT MEMBERS: ENUM SORTS MEMBERS ALPHABETICALLY

#[test]
fn test_sort_members_enum_sorts_members() {
    let source = "namespace Test\n{\n    public enum Priority\n    {\n        Zebra,\n        Alpha,\n        Middle\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 8, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits for enum");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let alpha_pos = new_text.find("Alpha").expect("Alpha");
    let middle_pos = new_text.find("Middle").expect("Middle");
    let zebra_pos = new_text.find("Zebra").expect("Zebra");
    assert!(
        alpha_pos < middle_pos && middle_pos < zebra_pos,
        "expected alphabetical enum members",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
