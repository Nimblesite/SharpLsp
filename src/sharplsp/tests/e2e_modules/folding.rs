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

    // LSP 3.17 gives the run of `using` directives the `imports` kind — that is
    // the kind's whole purpose — and it must span both lines, not just one.
    let imports = ranges
        .iter()
        .find(|r| r["kind"] == "imports")
        .unwrap_or_else(|| panic!("the using header must fold as `imports`, got {ranges:?}"));
    assert_eq!(
        imports["startLine"], 0,
        "the imports fold starts on the first using"
    );
    assert_eq!(
        imports["endLine"], 1,
        "the imports fold ends on the last using"
    );

    // The class body folds on its own shape and carries NO kind: LSP 3.17
    // reserves `region` for a range the user marked with `#region`, and this
    // source contains none.
    let class_fold = ranges
        .iter()
        .find(|r| r["startLine"] == 3 && r["kind"].is_null())
        .unwrap_or_else(|| panic!("the class must fold with no kind, got {ranges:?}"));
    assert_eq!(
        class_fold["endLine"], 5,
        "the class fold runs to its closing brace"
    );
    assert!(
        !ranges.iter().any(|r| r["kind"] == "region"),
        "nothing may claim `region` in a source with no #region, got {ranges:?}",
    );

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
                "text": "module M\n\
        (* a multi-line\n   block comment *)\n\
        type Shape =\n    | Circle of radius: float\n    | Square of side: float\n\
        let area shape =\n    match shape with\n    | Circle r -> 3.14159 * r * r\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": fs_uri } }),
    );
    // The F# tree-sitter grammar is integrated, so folding serves F# exactly
    // as it serves C# ([SHARPLSP-SPEC] syntax-only table) — it must NOT error.
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");
    let ranges = resp["result"].as_array().unwrap();
    assert!(!ranges.is_empty(), "F# constructs must fold");

    let kinds: Vec<&str> = ranges
        .iter()
        .map(|r| r["kind"].as_str().unwrap_or(""))
        .collect();

    // The module, the type and the let-binding each fold on their own shape and
    // carry NO kind: LSP 3.17 reserves `region` for a `#region` the user wrote,
    // and F# has no such directive at all.
    let structural = kinds.iter().filter(|k| k.is_empty()).count();
    assert!(
        structural >= 3,
        "module, type and let must each fold with no kind, got {kinds:?}"
    );
    assert!(
        !kinds.contains(&"region"),
        "no F# construct may be tagged `region`, got {kinds:?}"
    );
    // The (* ... *) comment folds as a comment.
    assert!(
        kinds.contains(&"comment"),
        "a multi-line (* *) comment must fold, got {kinds:?}"
    );

    // Every fold spans real lines, like the C# contract.
    for r in ranges {
        let start = r["startLine"].as_u64().unwrap();
        let end = r["endLine"].as_u64().unwrap();
        assert!(end > start, "folding range end must be after start: {r}");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
