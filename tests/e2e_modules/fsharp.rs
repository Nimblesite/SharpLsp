use super::*;

// ── F# File Tests ───────────────────────────────────────────────

#[test]
fn test_fsharp_file_errors_gracefully() {
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
                "text": "module MyModule\nlet x = 42\n",
            }
        }),
    );

    // This should return an error because F# tree-sitter isn't integrated yet.
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fs_uri } }),
    );
    assert!(
        resp.get("error").is_some(),
        "F# should error (not yet integrated)"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_fsharp_fsx_extension() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fsx_uri = "file:///test/Script.fsx";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fsx_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "printfn \"hello\"\n",
            }
        }),
    );

    // .fsx should be recognized as F# and error (grammar not integrated).
    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fsx_uri } }),
    );
    assert!(resp.get("error").is_some(), "fsx should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

#[test]
fn test_fsharp_fsi_extension() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let fsi_uri = "file:///test/Signature.fsi";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": fsi_uri,
                "languageId": "fsharp",
                "version": 1,
                "text": "module MyModule\nval x : int\n",
            }
        }),
    );

    let resp = client.request(
        "textDocument/documentSymbol",
        json!({ "textDocument": { "uri": fsi_uri } }),
    );
    assert!(resp.get("error").is_some(), "fsi should error");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── F# Hover Tests (Full-Stack) ─────────────────────────────────

// 40. F# HOVER ON FUNCTION/TYPE/MODULE

#[test]
fn test_full_stack_fsharp_hover_function_type_module() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // Wait for F# sidecar — poll hover on "Calculator" module (line 3, char 7).
    let module_hover =
        poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));
    let md = module_hover["contents"]["value"].as_str().unwrap();
    assert!(!md.is_empty(), "F# module hover must not be empty: {md}");
    assert!(md.contains("```"), "must have code block: {md}");

    // Hover on `add` function (line 5, char 8).
    let fn_hover = hover(&mut client, &file_uri, 5, 8);
    assert_hover_ok(&fn_hover);
    assert!(
        !fn_hover["result"].is_null(),
        "function hover must not be null"
    );
    let fn_md = fn_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        fn_md.contains("```"),
        "function hover must have code block: {fn_md}"
    );

    // Hover on `Shape` type (line 11, char 5).
    let type_hover = hover(&mut client, &file_uri, 11, 5);
    assert_hover_ok(&type_hover);
    assert!(
        !type_hover["result"].is_null(),
        "type hover must not be null"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 41. F# HOVER ON DU CASE

#[test]
fn test_full_stack_fsharp_hover_du_case() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));

    // Hover on `Circle` DU case (line 12, char 6).
    let du_hover = hover(&mut client, &file_uri, 12, 6);
    assert_hover_ok(&du_hover);
    assert!(
        !du_hover["result"].is_null(),
        "DU case hover must not be null"
    );
    let md = du_hover["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "DU hover must have code block: {md}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 42. F# HOVER ON PIPELINE OPERATOR

#[test]
fn test_full_stack_fsharp_hover_pipeline() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));

    // Hover on `List.map` in pipeline (line 23, char 14).
    let h = hover(&mut client, &file_uri, 23, 14);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "pipeline hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(
        md.contains("```"),
        "pipeline hover must have code block: {md}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// 43. F# HOVER WITH XML DOCUMENTATION

#[test]
fn test_full_stack_fsharp_hover_xml_docs() {
    require_dotnet();

    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = LspClient::start_verbose();
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    let _ = poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));

    // Hover on `add` function (line 5, char 8) — has doc "Adds two integers".
    let h = hover(&mut client, &file_uri, 5, 8);
    assert_hover_ok(&h);
    assert!(!h["result"].is_null(), "hover must not be null");
    let md = h["result"]["contents"]["value"].as_str().unwrap();
    assert!(md.contains("```"), "must have code block: {md}");
    assert!(
        md.to_lowercase().contains("adds") || md.to_lowercase().contains("sum"),
        "F# hover must include XML doc: {md}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
