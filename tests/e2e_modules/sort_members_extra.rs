use super::*;

// ── Sort Members E2E Tests (continued) ───────────────────────────────────────

// 59. SORT MEMBERS: INVALID RANGE RETURNS ERROR

#[test]
fn test_sort_members_invalid_range_returns_error() {
    let source = "namespace Test { }\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 99, "character": 0 },
                "end": { "line": 99, "character": 0 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "expected error for invalid range: {resp}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 60. SORT MEMBERS: MIXED ACCESSIBILITY AND CATEGORY

#[test]
fn test_sort_members_mixed_accessibility_and_category() {
    let source = "namespace Test\n{\n    public class Mixed\n    {\n        private void PrivateMethod() { }\n        public int PublicField;\n        internal int InternalProp { get; set; }\n        public void PublicMethod() { }\n        private int PrivateField;\n        public Mixed() { }\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 10, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits");

    let new_text = edits[0]["newText"].as_str().unwrap();
    let pub_field = new_text.find("PublicField").expect("PublicField");
    let pub_ctor = new_text.find("Mixed()").expect("Mixed()");
    let pub_method = new_text.find("PublicMethod").expect("PublicMethod");
    assert!(
        pub_field < pub_ctor && pub_ctor < pub_method,
        "public: field < ctor < method",
    );

    let int_prop = new_text.find("InternalProp").expect("InternalProp");
    assert!(pub_method < int_prop, "internal after public");

    let priv_field = new_text.find("PrivateField").expect("PrivateField");
    let priv_method = new_text.find("PrivateMethod").expect("PrivateMethod");
    assert!(
        int_prop < priv_field && priv_field < priv_method,
        "private last, field before method",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 61. SORT MEMBERS: STRUCT SORTS MEMBERS

#[test]
fn test_sort_members_struct_sorts_members() {
    let source = "namespace Test\n{\n    public struct Point\n    {\n        public void Reset() { }\n        public int Y;\n        public int X;\n    }\n}\n";
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
    let x_pos = new_text.find("int X").expect("X");
    let y_pos = new_text.find("int Y").expect("Y");
    let reset_pos = new_text.find("Reset").expect("Reset");
    assert!(x_pos < y_pos, "X before Y alphabetically");
    assert!(y_pos < reset_pos, "fields before methods");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 62. SORT MEMBERS: PRESERVES COMMENTS AND ATTRIBUTES

#[test]
fn test_sort_members_preserves_comments_and_attributes() {
    let source = "namespace Test\n{\n    public class Decorated\n    {\n        // Private helper\n        [System.Obsolete]\n        private void Helper() { }\n        /// <summary>Public API</summary>\n        public void Api() { }\n    }\n}\n";
    let (_tmp, _path, uri) = create_sort_members_file(source);
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/sortMembers",
        json!({
            "uri": uri,
            "range": {
                "start": { "line": 2, "character": 4 },
                "end": { "line": 9, "character": 5 }
            },
            "sortConfig": default_sort_config()
        }),
    );

    assert!(resp.get("error").is_none(), "must not error: {resp}");
    let edits = resp["result"]["edits"].as_array().unwrap();
    assert!(!edits.is_empty(), "expected reorder edits");

    let new_text = edits[0]["newText"].as_str().unwrap();
    // Public Api() should come first, with its doc comment.
    let api_pos = new_text.find("Api").expect("Api");
    let helper_pos = new_text.find("Helper").expect("Helper");
    assert!(api_pos < helper_pos, "public before private");
    // Comments and attributes must still be present.
    assert!(
        new_text.contains("/// <summary>Public API</summary>"),
        "doc comment preserved"
    );
    assert!(
        new_text.contains("[System.Obsolete]"),
        "attribute preserved"
    );
    assert!(
        new_text.contains("// Private helper"),
        "line comment preserved"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 63. SORT MEMBERS: INSERTS BLANK LINES BETWEEN GROUPS

#[test]
fn test_sort_members_inserts_blank_lines_between_groups() {
    let source = "namespace Test\n{\n    public class Groups\n    {\n        private void PrivMethod() { }\n        public int PubField;\n        public void PubMethod() { }\n    }\n}\n";
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
    // Public members come first, then private — separated by blank line.
    let pub_field = new_text.find("PubField").expect("PubField");
    let priv_method = new_text.find("PrivMethod").expect("PrivMethod");
    assert!(pub_field < priv_method, "public before private");
    // There should be a double newline (blank line) between the groups.
    let between = &new_text[pub_field..priv_method];
    assert!(
        between.contains("\n\n"),
        "blank line between accessibility groups"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 64. SORT MEMBERS: REGION BLOCKS PRESERVED AS TRIVIA

#[test]
fn test_sort_members_preserves_region_blocks() {
    let source = "namespace Test\n{\n    public class Regions\n    {\n        #region Private\n        private void Beta() { }\n        #endregion\n        public void Alpha() { }\n    }\n}\n";
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
    // Public Alpha should come first.
    let alpha_pos = new_text.find("Alpha").expect("Alpha");
    let beta_pos = new_text.find("Beta").expect("Beta");
    assert!(alpha_pos < beta_pos, "public before private");
    // Region directives must still be in the output.
    assert!(new_text.contains("#region"), "#region preserved");
    assert!(new_text.contains("#endregion"), "#endregion preserved");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
