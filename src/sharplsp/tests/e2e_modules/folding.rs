use super::*;

// 4. FOLDING RANGES

#[test]
fn test_folding_ranges_basic() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let ranges = resp["result"].as_array().unwrap();
    assert!(!ranges.is_empty(), "should have folding ranges");

    // Should have at least: namespace, class, method.
    assert!(
        ranges.len() >= 3,
        "expected at least 3 folding ranges, got {}",
        ranges.len()
    );

    // Check that ranges have proper structure.
    for r in ranges {
        assert!(r.get("startLine").is_some());
        assert!(r.get("endLine").is_some());
        let start = r["startLine"].as_u64().unwrap();
        let end = r["endLine"].as_u64().unwrap();
        assert!(end > start, "folding range end must be after start");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_ranges_using_directives() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "using System;\nusing System.Collections.Generic;\n\npublic class Foo\n{\n}\n";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let ranges = resp["result"].as_array().unwrap();

    // Using directives are single-line so they may not produce folds,
    // but the class should.
    let region = ranges.iter().find(|r| r["kind"] == "region");
    assert!(region.is_some(), "should have region fold for class");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_ranges_empty_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();
    client.open_document(TEST_URI, EMPTY_FILE);

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let ranges = resp["result"].as_array().unwrap();
    assert!(ranges.is_empty(), "empty file should have no folds");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_range_on_unopened_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": "file:///nope.cs" } }),
    );
    assert!(resp.get("error").is_some(), "should error on unopened doc");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_ranges_multiline_comment() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "/* This is a\n   multi-line\n   comment */\npublic class Foo\n{\n}\n";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let ranges = resp["result"].as_array().unwrap();

    // Should have a comment fold for the multi-line /* */ comment.
    let comment_fold = ranges.iter().find(|r| r["kind"] == "comment");
    assert!(
        comment_fold.is_some(),
        "should have comment fold for multi-line /* */ comment, got: {ranges:?}"
    );
    if let Some(cf) = comment_fold {
        assert_eq!(cf["startLine"], 0);
        assert_eq!(cf["endLine"], 2);
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_ranges_switch_body() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = r"public class Foo
{
    public void Bar(int x)
    {
        switch (x)
        {
            case 1:
                break;
            case 2:
                break;
        }
    }
}
";
    client.open_document(TEST_URI, code);

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let ranges = resp["result"].as_array().unwrap();
    assert!(
        ranges.len() >= 4,
        "should fold class, method, block, and switch body: got {}",
        ranges.len()
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_folding_range_on_fsharp_file() {
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
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": fs_uri } }),
    );
    assert!(resp.get("error").is_some(), "F# foldingRange should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
