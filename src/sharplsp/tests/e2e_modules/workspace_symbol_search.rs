//! Live search across both language engines. [SE-FSHARP-SYMBOLS] [SHARPLSP-FEATURES-NAVIGATION]
use super::*;

const FSHARP: &str = "module TestFSharp\nmodule Calculator =\n    let add (a: int) (b: int) = a + b\nlet twice = fun value -> value * 2\nlet answer = 42\n";

/// One symbol from the real standard LSP response, with its identity intact.
fn assert_search(client: &mut LspClient, query: &str, name: &str, uri: &str, kind: u32) {
    let response = client.request("workspace/symbol", json!({"query": query}));
    assert_rpc_ok(&response, "live workspace symbol search");
    let symbols = response["result"]
        .as_array()
        .expect("standard symbol array");
    assert_eq!(symbols.len(), 1, "one matching declaration: {response}");
    assert_eq!(symbols[0]["name"], name);
    assert_eq!(symbols[0]["kind"], kind, "the declared symbol kind");
    assert_eq!(symbols[0]["location"]["uri"], uri);
    assert!(symbols[0]["location"]["range"].is_object());
}

#[test]
fn workspace_symbol_search_follows_fsharp_functions_csharp_delegates_and_closed_documents() {
    require_dotnet();
    let (fsharp, root, fsharp_uri, _) = create_fsharp_test_workspace();
    let (csharp, _, csharp_uri, _) = create_test_workspace();
    std::fs::write(
        fsharp.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n",
    )
    .expect("F# search must not depend on Roslyn");
    std::fs::write(csharp.path().join("TestHover/Program.cs"), COMPLEX_CLASS)
        .expect("write complete C# delegate fixture");
    std::fs::write(fsharp.path().join("TestFSharp/Library.fs"), FSHARP)
        .expect("write complete F# function, lambda and value fixture");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(fsharp.path()));
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize F# first",
    );
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument": {
            "uri": fsharp_uri, "languageId": "fsharp", "version": 1, "text": FSHARP
        }}),
    );
    let _ = poll_hover_until_ready(&mut client, &fsharp_uri, 2, 8, Duration::from_secs(90));
    client.open_document(&csharp_uri, COMPLEX_CLASS);
    assert_search(&mut client, "ADD", "add", &fsharp_uri, 12);
    assert_search(&mut client, "TWICE", "twice", &fsharp_uri, 12);
    assert_search(&mut client, "ANSWER", "answer", &fsharp_uri, 8);
    assert_search(&mut client, "eventhandler", "EventHandler", &csharp_uri, 12);
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument": {
            "uri": path_to_file_uri(&csharp.path().join("notes.txt")), "languageId": "plaintext",
            "version": 1, "text": "EventHandler add are plain text here"
        }}),
    );
    assert_search(&mut client, "eventhandler", "EventHandler", &csharp_uri, 12);
    client.close_document(&fsharp_uri);
    let missing = client.request("workspace/symbol", json!({"query": "ADD"}));
    assert_rpc_ok(
        &missing,
        "closing a document removes its live search entries",
    );
    assert_eq!(missing["result"], json!([]));
    assert_search(&mut client, "eventhandler", "EventHandler", &csharp_uri, 12);
    client.close_document(&csharp_uri);
    let empty = client.request("workspace/symbol", json!({"query": ""}));
    assert_rpc_ok(&empty, "unsupported plain text cannot become a code symbol");
    assert_eq!(empty["result"], json!([]));
    client.shutdown_and_exit();
}
