//! Editor acceptance across the real LSP and compiler. [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT]
use super::*;
use fixtures_cross_language::dotnet;

const SOURCE: &str = "namespace TestHover;\npublic static class Writer\n{\n    public static object Create() => new StringB();\n}\n";

#[test]
fn resolved_auto_import_completion_produces_a_real_compilable_project() {
    require_dotnet();
    let (workspace, root, uri, _) = create_test_workspace();
    let source_path = workspace.path().join("TestHover/Program.cs");
    std::fs::write(&source_path, SOURCE).expect("write entire completion fixture");
    let mut client = LspClient::start();
    assert_rpc_ok(&client.initialize_with_root(json!(root)), "initialize");
    client.open_document(&uri, SOURCE);
    let _ = poll_hover_until_ready(&mut client, &uri, 1, 23, Duration::from_secs(90));
    let response = position_request(&mut client, "textDocument/completion", &uri, (3, 48));
    assert_rpc_ok(&response, "complete an unimported framework type");
    let items = response["result"]
        .as_array()
        .expect("real completion items");
    let item = items
        .iter()
        .find(|item| item["label"] == "StringBuilder")
        .expect("System.Text.StringBuilder is offered without an existing using");
    assert!(item["data"]["index"]
        .as_i64()
        .is_some_and(|index| index >= 0));
    assert!(item["data"]["file_path"].is_string());
    assert_eq!(item["textEdit"]["newText"], "StringBuilder");
    assert_eq!(
        item["textEdit"]["range"]["start"],
        json!({"line": 3, "character": 41})
    );
    assert_eq!(
        item["textEdit"]["range"]["end"],
        json!({"line": 3, "character": 48})
    );
    let resolved = client.request("completionItem/resolve", item.clone());
    assert_rpc_ok(&resolved, "resolve the import required by acceptance");
    assert_eq!(resolved["result"]["label"], item["label"]);
    assert_eq!(resolved["result"]["data"], item["data"]);
    assert_eq!(resolved["result"]["textEdit"], item["textEdit"]);
    let imports = resolved["result"]["additionalTextEdits"]
        .as_array()
        .expect("resolving an unimported type must supply its import");
    assert_eq!(
        imports.len(),
        1,
        "one namespace import, without duplicate edits"
    );
    let mut edits = imports.clone();
    edits.push(item["textEdit"].clone());
    let accepted = apply_text_edits(SOURCE, &edits);
    std::fs::write(&source_path, &accepted).expect("apply protocol edits as an editor does");
    client.change_document(&uri, 2, &accepted);
    client.save_document(&uri);
    dotnet(
        &["build", "TestHover/TestHover.csproj", "--nologo"],
        workspace.path(),
    );
    let hover = hover(&mut client, &uri, 2, 23);
    assert_rpc_ok(&hover, "semantic requests survive completion acceptance");
    client.shutdown_and_exit();
}
