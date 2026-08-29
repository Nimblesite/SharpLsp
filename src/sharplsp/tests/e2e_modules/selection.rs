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
                "text": "module M\nlet x =\n    let y = 1\n    y + 1\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": fs_uri },
            "positions": [{ "line": 2, "character": 8 }]
        }),
    );
    // The F# tree-sitter grammar is integrated, so selection ranges serve F#
    // exactly as they serve C# — a nested chain up to the file root.
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let ranges = resp["result"].as_array().unwrap();
    assert_eq!(ranges.len(), 1, "one range per position");

    let r = &ranges[0];
    assert!(
        r.get("range").is_some(),
        "each selection range carries a range"
    );
    // The chain must nest: inner range up through the module to the file root.
    let mut current = r.clone();
    let mut depth = 0usize;
    while let Some(parent) = current.get("parent").cloned() {
        let inner = current["range"].clone();
        let outer = parent["range"].clone();
        assert!(
            inner["start"]["line"].as_u64() >= outer["start"]["line"].as_u64()
                && inner["end"]["line"].as_u64() <= outer["end"]["line"].as_u64(),
            "each parent must enclose its child: inner {inner} outer {outer}"
        );
        current = parent;
        depth += 1;
    }
    assert!(
        depth >= 2,
        "F# chain must nest past the binding to the module, depth {depth}"
    );
    assert_eq!(
        current["range"]["start"]["line"],
        serde_json::json!(0),
        "the outermost range starts at the file root"
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
            "position": { "line": 0, "character": 2 }
        }),
    );
    // The F# grammar is integrated, so the request is served (no error). F#
    // `///` docs are xml_doc nodes without linked open/close tag pairs, so the
    // honest answer is `null` — the same contract as C# comments.
    assert!(
        resp.get("error").is_none(),
        "F# linkedEditingRange must be served, not error: {resp}"
    );
    assert!(
        resp.get("result").is_none() || resp["result"].is_null(),
        "F# has no linked tag pairs, so the result is null: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
