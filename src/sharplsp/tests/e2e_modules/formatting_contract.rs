//! Dedicated formatters own both languages. [SHARPLSP-FEATURES-FORMATTING]
use super::*;

#[test]
fn dedicated_formatters_remain_in_charge_for_fsharp_and_csharp() {
    let (_fsharp, fsharp_root, fsharp_uri, fsharp_source) = create_fsharp_test_workspace();
    let (_csharp, csharp_root, csharp_uri, csharp_source) = create_test_workspace();
    let mut client = LspClient::start();
    let initialized = client.initialize_with_params(json!({
        "capabilities": {}, "workspaceFolders": [
            {"uri": fsharp_root, "name": "F#"}, {"uri": csharp_root, "name": "C#"}
        ]
    }));
    assert_rpc_ok(&initialized, "initialize both language workspaces");
    let capabilities = &initialized["result"]["capabilities"];
    for capability in [
        "documentFormattingProvider",
        "documentRangeFormattingProvider",
        "documentOnTypeFormattingProvider",
    ] {
        assert!(
            capabilities.get(capability).is_none(),
            "dedicated formatters retain {capability}"
        );
    }
    for (uri, language, source) in [
        (fsharp_uri, "fsharp", fsharp_source),
        (csharp_uri, "csharp", csharp_source),
    ] {
        client.notify(
            "textDocument/didOpen",
            json!({"textDocument": {
                "uri": uri, "languageId": language, "version": 1, "text": source
            }}),
        );
        let position = if language == "fsharp" {
            (5, 8)
        } else {
            (3, 14)
        };
        let _ = poll_hover_until_ready(
            &mut client,
            &uri,
            position.0,
            position.1,
            Duration::from_secs(90),
        );
        for method in [
            "textDocument/formatting",
            "textDocument/rangeFormatting",
            "textDocument/onTypeFormatting",
        ] {
            let response = client.request(method, json!({
                "textDocument": {"uri": uri}, "options": {"tabSize": 4, "insertSpaces": true},
                "range": {"start": {"line": 0, "character": 0}, "end": {"line": 1, "character": 0}},
                "position": {"line": 0, "character": 0}, "ch": ";"
            }));
            assert_eq!(response["jsonrpc"], "2.0");
            assert!(
                response["error"].is_object(),
                "unadvertised {method} is refused for {language}"
            );
            assert!(
                response.get("result").is_none(),
                "no formatter edits may reach the editor"
            );
        }
        let symbols = document_request(&mut client, "textDocument/documentSymbol", &uri);
        assert_rpc_ok(&symbols, "language features survive refused formatting");
        assert!(symbols["result"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }
    client.shutdown_and_exit();
}
