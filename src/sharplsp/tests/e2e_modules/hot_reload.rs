//! Real LSP → Roslyn Edit-and-Continue sessions. [DEBUG-FEATURES-HOT-RELOAD]
use super::*;
use fixtures_cross_language::dotnet;

const BASELINE: &str = "public static class Counter { public static int Value() => 1; }";
const CHANGED: &str = "public static class Counter { public static int Value() => 2; }";
const RUDE: &str = "public static class Counter { public static int Value(int n) => n; }";

/// Validate the editor-facing envelope and every stable session field.
fn session_result(client: &mut LspClient, params: Value, status: &str) -> Value {
    let response = client.request("sharplsp/hotReload", params);
    assert_rpc_ok(&response, status);
    let result = response["result"].clone();
    assert_eq!(result["status"], status, "{response}");
    assert_eq!(result["assemblyName"], "TestHover", "{response}");
    assert!(result["sessionId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert!(result["updates"].is_array(), "{response}");
    assert!(result["diagnostics"].is_array(), "{response}");
    result
}

#[test]
fn real_hot_reload_emits_deltas_discards_commits_and_explains_rude_edits() {
    require_dotnet();
    let (workspace, root, _, _) = create_test_workspace();
    let project = workspace.path().join("TestHover/TestHover.csproj");
    let source = workspace.path().join("TestHover/Program.cs");
    std::fs::write(&source, BASELINE).expect("write complete baseline source");
    dotnet(
        &[
            "build",
            "TestHover/TestHover.csproj",
            "-c",
            "Debug",
            "--nologo",
        ],
        workspace.path(),
    );
    let mut client = LspClient::start();
    assert_rpc_ok(&client.initialize_with_root(json!(root)), "initialize");
    let started = session_result(
        &mut client,
        json!({"action": "start", "projectPath": project}),
        "started",
    );
    assert_eq!(started["updates"], json!([]));
    assert_eq!(started["diagnostics"], json!([]));
    let id = started["sessionId"].clone();
    for finish in ["discard", "commit"] {
        let update = session_result(
            &mut client,
            json!({"action": "update", "sessionId": id,
                "documents": [{"filePath": source, "newText": CHANGED}]}),
            "applied",
        );
        assert_eq!(update["sessionId"], id);
        assert_eq!(update["diagnostics"], json!([]));
        let deltas = update["updates"].as_array().expect("delta array");
        assert_eq!(deltas.len(), 1, "one changed assembly: {update}");
        for field in ["moduleId", "metadataDelta", "ilDelta", "pdbDelta"] {
            assert!(
                deltas[0][field]
                    .as_str()
                    .is_some_and(|value| !value.is_empty()),
                "{field} must reach the editor: {update}"
            );
        }
        let finished = session_result(
            &mut client,
            json!({"action": finish, "sessionId": id}),
            if finish == "commit" {
                "committed"
            } else {
                "discarded"
            },
        );
        assert_eq!(finished["sessionId"], id);
        assert_eq!(finished["updates"], json!([]));
        assert_eq!(finished["diagnostics"], json!([]));
    }
    let rude = session_result(
        &mut client,
        json!({"action": "update", "sessionId": id, "filePath": source, "newText": RUDE}),
        "restartRequired",
    );
    assert_eq!(rude["sessionId"], id);
    assert_eq!(
        rude["updates"],
        json!([]),
        "rude edits never produce runtime deltas"
    );
    assert!(rude["diagnostics"]
        .as_array()
        .is_some_and(|messages| !messages.is_empty()));
    let ended = session_result(
        &mut client,
        json!({"action": "end", "sessionId": id}),
        "ended",
    );
    assert_eq!(ended["sessionId"], id);
    assert_eq!(ended["updates"], json!([]));
    assert_eq!(ended["diagnostics"], json!([]));
    let stale = client.request(
        "sharplsp/hotReload",
        json!({"action": "commit", "sessionId": id}),
    );
    assert!(
        stale.get("error").is_some(),
        "an ended session is rejected: {stale}"
    );
    assert!(
        stale.get("result").is_none(),
        "a failure cannot look successful"
    );
    assert_rpc_ok(
        &client.request("sharplsp/configuration", json!({})),
        "host remains responsive",
    );
    client.shutdown_and_exit();
}

#[test]
fn hot_reload_without_csharp_reports_failure_and_preserves_other_lsp_features() {
    let mut client = LspClient::start_without_sidecars();
    assert_rpc_ok(&client.initialize(), "initialize without sidecars");
    for params in [
        json!({"action": "start"}),
        json!({"action": "end", "sessionId": "missing"}),
    ] {
        let response = client.request("sharplsp/hotReload", params);
        assert_eq!(response["jsonrpc"], "2.0");
        assert!(response["id"].is_number());
        assert!(response["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("C# sidecar")));
        assert!(response.get("result").is_none());
    }
    client.open_document(TEST_URI, SIMPLE_CLASS);
    let symbols = document_request(&mut client, "textDocument/documentSymbol", TEST_URI);
    assert_rpc_ok(&symbols, "syntax features survive failed hot reload");
    assert!(symbols["result"]
        .as_array()
        .is_some_and(|symbols| !symbols.is_empty()));
    client.shutdown_and_exit();
}
