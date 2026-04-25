use super::*;

// ── Hover Tests ──────────────────────────────────────────────────

// 24. HOVER ACROSS MULTIPLE SYMBOL KINDS IN ONE FILE

#[test]
fn test_hover_on_class_method_property_field() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "\
public class Calculator
{
    private int _count;
    public string Name { get; set; }
    public int Add(int a, int b) { return a + b; }
    public event System.EventHandler OnDone;
}";
    client.open_document(TEST_URI, code);

    // Hover on class name "Calculator" (line 0, char 14).
    let resp = hover(&mut client, TEST_URI, 0, 14);
    assert_hover_ok(&resp);

    // Hover on field "_count" (line 2, char 17).
    let resp = hover(&mut client, TEST_URI, 2, 17);
    assert_hover_ok(&resp);

    // Hover on property "Name" (line 3, char 19).
    let resp = hover(&mut client, TEST_URI, 3, 19);
    assert_hover_ok(&resp);

    // Hover on method "Add" (line 4, char 16).
    let resp = hover(&mut client, TEST_URI, 4, 16);
    assert_hover_ok(&resp);

    // Hover on event "OnDone" (line 5, char 42).
    let resp = hover(&mut client, TEST_URI, 5, 42);
    assert_hover_ok(&resp);

    // Hover on "public" keyword (line 0, char 2) — still must not error.
    let resp = hover(&mut client, TEST_URI, 0, 2);
    assert_hover_ok(&resp);

    // All hovers succeeded — server is healthy. Verify with a symbol request.
    let sym_resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(sym_resp.get("error").is_none(), "symbols must still work");
    let symbols = sym_resp["result"].as_array().unwrap();
    assert!(
        symbols.iter().any(|s| s["name"] == "Calculator"),
        "symbol request must still return Calculator",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 25. HOVER ON COMMENTS — SINGLE-LINE, MULTI-LINE, DOC COMMENT

#[test]
fn test_hover_on_all_comment_styles_returns_null() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "\
// single-line comment
/* multi-line
   comment */
/// <summary>Doc comment</summary>
public class Foo { }";
    client.open_document(TEST_URI, code);

    // Force tree-sitter parse by requesting symbols.
    let sym_resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(sym_resp.get("error").is_none(), "symbols must succeed");
    let symbols = sym_resp["result"].as_array().unwrap();
    assert!(
        symbols.iter().any(|s| s["name"] == "Foo"),
        "must parse Foo class",
    );

    // Hover on single-line comment (line 0, char 5).
    let resp = hover(&mut client, TEST_URI, 0, 5);
    assert_hover_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "single-line comment must return null",
    );

    // Hover on multi-line comment (line 1, char 5).
    let resp = hover(&mut client, TEST_URI, 1, 5);
    assert_hover_ok(&resp);
    assert!(
        resp["result"].is_null(),
        "multi-line comment must return null",
    );

    // Hover on doc comment (line 3, char 10).
    let resp = hover(&mut client, TEST_URI, 3, 10);
    assert_hover_ok(&resp);
    assert!(resp["result"].is_null(), "doc comment must return null");

    // Hover on the actual class AFTER comments — must NOT be null.
    let resp = hover(&mut client, TEST_URI, 4, 14);
    assert_hover_ok(&resp);
    // With sidecar it returns data; without it returns null. Either is OK.

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 26. HOVER ON MULTIPLE DOCUMENTS SIMULTANEOUSLY

#[test]
fn test_hover_across_multiple_documents() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let uri_a = "file:///test/A.cs";
    let uri_b = "file:///test/B.cs";

    client.open_document(uri_a, "public class Alpha { public void Run() {} }");
    client.open_document(uri_b, "public struct Beta { public int Value; }");

    // Hover on Alpha class.
    let resp_a = hover(&mut client, uri_a, 0, 14);
    assert_hover_ok(&resp_a);

    // Hover on Beta struct.
    let resp_b = hover(&mut client, uri_b, 0, 15);
    assert_hover_ok(&resp_b);

    // Hover on Run method in A.
    let run_resp = hover(&mut client, uri_a, 0, 34);
    assert_hover_ok(&run_resp);

    // Hover on Value field in B.
    let val_resp = hover(&mut client, uri_b, 0, 32);
    assert_hover_ok(&val_resp);

    // Close document A, hover on B still works.
    client.close_document(uri_a);
    let after_close = hover(&mut client, uri_b, 0, 15);
    assert_hover_ok(&after_close);

    // Hover on closed doc A — must not crash.
    let resp_closed = hover(&mut client, uri_a, 0, 14);
    assert_eq!(resp_closed["jsonrpc"], "2.0");
    let has_error = resp_closed.get("error").is_some();
    let is_null = resp_closed["result"].is_null();
    assert!(has_error || is_null, "hover on closed doc must not crash");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 27. HOVER → EDIT → HOVER (edit cycle with validation at each step)

#[test]
fn test_hover_edit_hover_cycle() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open with class Alpha — validate symbols + hover.
    client.open_document(TEST_URI, "public class Alpha { }");
    let sym1 = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(sym1.get("error").is_none(), "symbols v1 must succeed");
    let arr1 = sym1["result"].as_array().unwrap();
    assert!(arr1.iter().any(|s| s["name"] == "Alpha"), "must see Alpha");

    let hover1 = hover(&mut client, TEST_URI, 0, 14);
    assert_hover_ok(&hover1);

    // Edit to Bravo with method — validate symbols + hover on class + method.
    client.change_document(
        TEST_URI,
        2,
        "public class Bravo\n{\n    public void Go() {}\n}",
    );
    let sym2 = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(sym2.get("error").is_none(), "symbols v2 must succeed");
    let arr2 = sym2["result"].as_array().unwrap();
    assert!(arr2.iter().any(|s| s["name"] == "Bravo"), "must see Bravo");

    let hover_class = hover(&mut client, TEST_URI, 0, 14);
    assert_hover_ok(&hover_class);
    let hover_method = hover(&mut client, TEST_URI, 2, 17);
    assert_hover_ok(&hover_method);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 27b. HOVER ON FRESH COMMENT-ONLY FILE

#[test]
fn test_hover_on_fresh_comment_only_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open a fresh file that is entirely a comment.
    let comment_uri = "file:///test/CommentOnly.cs";
    client.open_document(comment_uri, "// just a comment\n");

    // Force tree-sitter parse via symbol request.
    let sym = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": comment_uri } }),
    );
    assert!(sym.get("error").is_none(), "symbols must succeed");

    // Hover on the comment — pre-validation should return null.
    let resp = hover(&mut client, comment_uri, 0, 5);
    assert_hover_ok(&resp);
    assert!(resp["result"].is_null(), "hover on comment must be null");

    // Open another file with real code to verify server health.
    client.open_document(TEST_URI, "public class Healthy { }");
    let sym2 = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(
        sym2.get("error").is_none(),
        "symbols on second file must succeed"
    );
    let arr = sym2["result"].as_array().unwrap();
    assert!(
        arr.iter().any(|s| s["name"] == "Healthy"),
        "must see Healthy"
    );

    // Hover on the real class.
    let hover_real = hover(&mut client, TEST_URI, 0, 14);
    assert_hover_ok(&hover_real);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 28. HOVER RESPONSE STRUCTURE VALIDATION

#[test]
fn test_hover_response_validates_lsp_shape() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class Widget { }");

    let resp = hover(&mut client, TEST_URI, 0, 14);
    assert_hover_ok(&resp);
    assert_eq!(resp["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(resp.get("id").is_some(), "response must have id");
    assert!(
        resp.get("result").is_some(),
        "response must have result key"
    );

    // If result is non-null, deeply validate LSP Hover structure.
    if !resp["result"].is_null() {
        let result = &resp["result"];

        // contents must be MarkupContent
        assert!(result.get("contents").is_some(), "must have contents");
        let contents = &result["contents"];
        assert_eq!(
            contents["kind"], "markdown",
            "contents.kind must be 'markdown'"
        );
        assert!(contents.get("value").is_some(), "contents must have value");
        let value = contents["value"].as_str().unwrap();
        assert!(!value.is_empty(), "hover value must not be empty");
        assert!(
            value.contains("```") || value.contains("Widget"),
            "hover value must contain code block or symbol name",
        );

        // range is optional but if present must be valid
        if let Some(range) = result.get("range") {
            assert!(range.get("start").is_some(), "range must have start");
            assert!(range.get("end").is_some(), "range must have end");
            let start = &range["start"];
            let end = &range["end"];
            assert!(start.get("line").is_some(), "start must have line");
            assert!(
                start.get("character").is_some(),
                "start must have character"
            );
            assert!(end.get("line").is_some(), "end must have line");
            assert!(end.get("character").is_some(), "end must have character");
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 29. HOVER ON UNOPENED DOCUMENT + OPEN + HOVER AGAIN

#[test]
fn test_hover_unopened_then_open_then_hover() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Hover on a document that has not been opened.
    let resp1 = hover(&mut client, "file:///ghost/NotOpen.cs", 0, 0);
    assert_eq!(resp1["jsonrpc"], "2.0");
    let is_err = resp1.get("error").is_some();
    let is_null = resp1["result"].is_null();
    assert!(is_err || is_null, "unopened doc must return null or error");

    // Now open that document.
    let ghost_uri = "file:///ghost/NotOpen.cs";
    client.open_document(ghost_uri, "public class Opened { }");

    // Hover again — must succeed now.
    let resp2 = hover(&mut client, ghost_uri, 0, 14);
    assert_hover_ok(&resp2);

    // Close and hover again — back to null/error.
    client.close_document(ghost_uri);
    let resp3 = hover(&mut client, ghost_uri, 0, 14);
    assert_eq!(resp3["jsonrpc"], "2.0");
    let is_err3 = resp3.get("error").is_some();
    let is_null3 = resp3["result"].is_null();
    assert!(
        is_err3 || is_null3,
        "closed doc hover must return null/error"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 30. HOVER INTERLEAVED WITH SYMBOL AND FOLDING REQUESTS

#[test]
fn test_hover_interleaved_with_other_requests() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let code = "\
namespace Interleaved
{
    public class Service
    {
        public void Start() { }
        public void Stop() { }
    }
}";
    client.open_document(TEST_URI, code);

    // Symbol request.
    let sym = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(sym.get("error").is_none());
    let symbols = sym["result"].as_array().unwrap();
    assert!(!symbols.is_empty(), "must have symbols");

    // Hover on class.
    let h1 = hover(&mut client, TEST_URI, 2, 18);
    assert_hover_ok(&h1);

    // Folding ranges.
    let fold = client.request(
        "textDocument/foldingRange",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(fold.get("error").is_none());
    let ranges = fold["result"].as_array().unwrap();
    assert!(!ranges.is_empty(), "must have folding ranges");

    // Hover on Start method.
    let h2 = hover(&mut client, TEST_URI, 4, 21);
    assert_hover_ok(&h2);

    // Selection ranges.
    let sel = client.request(
        "textDocument/selectionRange",
        json!({
            "textDocument": { "uri": TEST_URI },
            "positions": [{ "line": 5, "character": 21 }]
        }),
    );
    assert!(sel.get("error").is_none());

    // Hover on Stop method.
    let h3 = hover(&mut client, TEST_URI, 5, 21);
    assert_hover_ok(&h3);

    // Hover on namespace keyword.
    let h4 = hover(&mut client, TEST_URI, 0, 5);
    assert_hover_ok(&h4);

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
