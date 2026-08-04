use super::*;

// 5. SELECTION RANGES

#[test]
fn test_selection_ranges_basic() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "positions": [{ "line": 7, "character": 20 }]
        }),
    );
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let ranges = resp["result"].as_array().unwrap();
    assert_eq!(ranges.len(), 1);

    // Should be a nested structure with parent chain.
    let r = &ranges[0];
    assert!(r.get("range").is_some());
    assert!(r.get("parent").is_some(), "should have parent chain");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_selection_ranges_multiple_positions() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "positions": [
                { "line": 5, "character": 10 },
                { "line": 7, "character": 15 },
                { "line": 9, "character": 0 }
            ]
        }),
    );
    let ranges = resp["result"].as_array().unwrap();
    assert_eq!(ranges.len(), 3, "should return one range per position");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_selection_ranges_at_start() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, "public class Foo {}");

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "positions": [{ "line": 0, "character": 0 }]
        }),
    );
    let ranges = resp["result"].as_array().unwrap();
    assert_eq!(ranges.len(), 1);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_selection_range_on_unopened_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": "file:///nope.cs" },
            "positions": [{ "line": 0, "character": 0 }]
        }),
    );
    assert!(resp.get("error").is_some(), "should error on unopened doc");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_linked_editing_range_no_xml() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    // Plain code without XML doc comments.
    client.open_document(TEST_URI, "public class Foo {}");

    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 15 }
        }),
    );
    // No XML elements → null result (no linked ranges).
    assert!(resp.get("error").is_none(), "should not error: {resp}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_linked_editing_range_on_unopened_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": "file:///nope.cs" },
            "position": { "line": 0, "character": 0 }
        }),
    );
    assert!(resp.get("error").is_some(), "should error on unopened doc");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_linked_editing_range_with_xml_doc_comment() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // XML doc comments with <summary> tags.
    let code = "/// <summary>Hello</summary>\npublic class Foo {}\n";
    client.open_document(TEST_URI, code);

    // Position cursor inside the <summary> tag name on line 0.
    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "position": { "line": 0, "character": 6 }
        }),
    );
    // Whether tree-sitter produces xml_element nodes or not,
    // the server must not crash. Either we get linked ranges or null.
    assert!(resp.get("error").is_none(), "should not error: {resp}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_selection_range_on_fsharp_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Module.fs";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fs_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "module M\nlet x = 1\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": fs_uri },
            "positions": [{ "line": 0, "character": 0 }]
        }),
    );
    assert!(
        resp.get("error").is_some(),
        "F# selectionRange should error"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_linked_editing_range_on_fsharp_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fs_uri = "file:///test/Module.fs";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fs_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "module M\nlet x = 1\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/linkedEditingRange",
        json!({
            "textDocument": { "uri": fs_uri },
            "position": { "line": 0, "character": 0 }
        }),
    );
    assert!(
        resp.get("error").is_some(),
        "F# linkedEditingRange should error"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
