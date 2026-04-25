use super::*;

// 2. DOCUMENT SYNC

#[test]
fn test_did_open_then_document_symbol() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "unexpected error: {resp}");

    let symbols = &resp["result"];
    assert!(symbols.is_array());
    let arr = symbols.as_array().unwrap();
    assert!(!arr.is_empty(), "should have symbols");

    // Should find the namespace.
    let ns = arr.iter().find(|s| s["name"] == "MyApp");
    assert!(ns.is_some(), "should find namespace MyApp");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_did_change_updates_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open with simple class.
    client.open_document(TEST_URI, "public class Foo {}");

    // Verify initial state.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(symbols.iter().any(|s| s["name"] == "Foo"));

    // Change to a different class.
    client.change_document(TEST_URI, 2, "public class Bar {}");

    // Verify updated state.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(
        symbols.iter().any(|s| s["name"] == "Bar"),
        "should see Bar after change"
    );
    assert!(
        !symbols.iter().any(|s| s["name"] == "Foo"),
        "Foo should be gone"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_did_close_removes_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);
    client.close_document(TEST_URI);

    // Request on closed doc should fail.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(
        resp.get("error").is_some(),
        "should error on closed document"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_did_save_is_handled() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, SIMPLE_CLASS);
    // Save should not crash — it's a no-op notification.
    client.save_document(TEST_URI);

    // Server should still work after save.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "server should work after save");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_request_on_unopened_document() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Request symbols without opening the document first.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": "file:///nonexistent/File.cs" } }),
    );
    assert!(
        resp.get("error").is_some(),
        "should error on unopened document"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_request_on_unsupported_file_type() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open a .txt file — unsupported extension.
    let txt_uri = "file:///test/readme.txt";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": txt_uri,
                "languageId": "plaintext",
                "version": 1,
                "text": "hello world",
            }
        }),
    );

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": txt_uri } }),
    );
    assert!(
        resp.get("error").is_some(),
        "should error on unsupported file type"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_open_change_close_reopen() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Open → symbols.
    client.open_document(TEST_URI, "public class First {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let syms = resp["result"].as_array().unwrap();
    assert!(syms.iter().any(|s| s["name"] == "First"));

    // Close.
    client.close_document(TEST_URI);

    // Reopen with different content.
    client.open_document(TEST_URI, "public class Second {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let syms = resp["result"].as_array().unwrap();
    assert!(syms.iter().any(|s| s["name"] == "Second"));
    assert!(!syms.iter().any(|s| s["name"] == "First"));

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_multiple_documents_simultaneously() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let uri1 = "file:///test/File1.cs";
    let uri2 = "file:///test/File2.cs";

    client.open_document(uri1, "public class Alpha {}");
    client.open_document(uri2, "public class Beta {}");

    // Both should work independently.
    let resp1 = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri1 } }),
    );
    let resp2 = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri2 } }),
    );

    let s1 = resp1["result"].as_array().unwrap();
    let s2 = resp2["result"].as_array().unwrap();
    assert!(s1.iter().any(|s| s["name"] == "Alpha"));
    assert!(s2.iter().any(|s| s["name"] == "Beta"));

    // Close one, the other should still work.
    client.close_document(uri1);
    let resp2_again = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": uri2 } }),
    );
    assert!(resp2_again.get("error").is_none());

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_rapid_changes() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class V1 {}");
    client.change_document(TEST_URI, 2, "public class V2 {}");
    client.change_document(TEST_URI, 3, "public class V3 {}");
    client.change_document(TEST_URI, 4, "public class V4 {}");

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(
        symbols.iter().any(|s| s["name"] == "V4"),
        "should reflect latest version"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_malformed_did_open_params() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send didOpen with garbage params — should not crash.
    client.notify("textDocument/didOpen", json!({ "garbage": true }));

    // Server should still work after bad notification.
    client.open_document(TEST_URI, "public class Alive {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "server should still work");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_malformed_did_change_params() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    client.open_document(TEST_URI, "public class Foo {}");

    // Send didChange with garbage params.
    client.notify("textDocument/didChange", json!({ "not": "valid" }));

    // Original content should still be in VFS.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    let symbols = resp["result"].as_array().unwrap();
    assert!(
        symbols.iter().any(|s| s["name"] == "Foo"),
        "original content intact"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_malformed_did_save_params() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send didSave with garbage params — should not crash.
    client.notify("textDocument/didSave", json!({ "bad": "data" }));

    client.open_document(TEST_URI, "public class StillOk {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "server should still work");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_malformed_did_close_params() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send didClose with garbage params — should not crash.
    client.notify("textDocument/didClose", json!({ "nonsense": 42 }));

    client.open_document(TEST_URI, "public class Fine {}");
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": TEST_URI } }),
    );
    assert!(resp.get("error").is_none(), "server should still work");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
