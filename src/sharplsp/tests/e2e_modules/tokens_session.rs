//! Editor token-cache recovery over actual language engines. [SHARPLSP-FEATURES-HIGHLIGHTING]
use super::*;

/// A client cache reset receives full tokens, then resumes incremental results without losing data.
fn assert_token_cache(client: &mut LspClient, uri: &str) {
    let full = document_request(client, "textDocument/semanticTokens/full", uri);
    assert_rpc_ok(&full, "full semantic tokens");
    let data = full["result"]["data"]
        .as_array()
        .expect("actual semantic tokens");
    assert!(!data.is_empty(), "real declarations have semantic colors");
    assert_eq!(data.len() % 5, 0, "tokens are encoded in groups of five");
    assert!(full["result"]["resultId"].is_string());
    let stale = client.request(
        "textDocument/semanticTokens/full/delta",
        json!({"textDocument":{"uri":uri},"previousResultId":"previous-editor-session"}),
    );
    assert_rpc_ok(&stale, "editor cache missed");
    assert_eq!(
        stale["result"]["data"], full["result"]["data"],
        "a lost cache returns the complete current token set"
    );
    assert!(stale["result"].get("edits").is_none());
    assert_ne!(stale["result"]["resultId"], full["result"]["resultId"]);
    let unchanged = client.request(
        "textDocument/semanticTokens/full/delta",
        json!({"textDocument":{"uri":uri},"previousResultId":stale["result"]["resultId"]}),
    );
    assert_rpc_ok(&unchanged, "resumed token delta");
    assert_eq!(
        unchanged["result"]["edits"],
        json!([]),
        "an unchanged document needs no replacement tokens"
    );
    assert!(unchanged["result"].get("data").is_none());
    assert_ne!(unchanged["result"]["resultId"], stale["result"]["resultId"]);
}

#[test]
fn actual_fsharp_and_csharp_semantic_colors_survive_an_editor_cache_reset() {
    require_dotnet();
    let fsharp = create_fsharp_test_workspace();
    let csharp = create_test_workspace();
    for ((workspace, root, uri, source), language, cursor) in
        [(&fsharp, "fsharp", (5, 8)), (&csharp, "csharp", (9, 16))]
    {
        let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
        assert_rpc_ok(
            &client.initialize_with_root(json!(root)),
            "initialize real token project",
        );
        client.notify(
            "textDocument/didOpen",
            json!({"textDocument":{"uri":uri,"languageId":language,"version":1,"text":source}}),
        );
        let _ = poll_hover_until_ready(
            &mut client,
            uri,
            cursor.0,
            cursor.1,
            Duration::from_secs(90),
        );
        assert_token_cache(&mut client, uri);
        client.shutdown_and_exit();
    }
}
