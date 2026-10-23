//! Real SDK restore converges before semantic answers. [SCRIPT-FILEBASED-REFERENCES-FALLBACK] [DIAG-PUSH-GATE]
use super::*;

const SOURCE: &str = "#:package Newtonsoft.Json@13.0.3\nusing Newtonsoft.Json;\nvar value = JsonConvert.SerializeObject(new { Answer = 42 });\nSystem.Console.WriteLine(value);\n";
// A genuine custom MSBuild target makes the pending-restore interaction observable
// even with a warm NuGet cache, without replacing the SDK or the Roslyn engine.
const TARGETS: &str = r#"<Project>
  <UsingTask TaskName="SlowRestore" TaskFactory="RoslynCodeTaskFactory" AssemblyFile="$(MSBuildToolsPath)/Microsoft.Build.Tasks.Core.dll">
    <Task><Code Type="Fragment" Language="cs">System.Threading.Thread.Sleep(3000);</Code></Task>
  </UsingTask>
  <Target Name="ObservePendingRestore" BeforeTargets="Restore"><SlowRestore /></Target>
</Project>"#;

/// Diagnostic codes are the protocol state; message prose is never parsed.
fn has_code(publication: &Value, code: &str) -> bool {
    publication["params"]["diagnostics"]
        .as_array()
        .is_some_and(|diagnostics| {
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic["code"] == code)
        })
}

#[test]
fn file_based_restore_replaces_provisional_diagnostics_before_semantic_answers() {
    require_dotnet();
    let workspace = tempfile::tempdir().expect("real file-based app directory");
    let file = workspace.path().join("app.cs");
    std::fs::write(&file, SOURCE).expect("write entire SDK file-based app");
    std::fs::write(workspace.path().join("Directory.Build.targets"), TARGETS)
        .expect("write real restore target");
    let uri = path_to_file_uri(&file);
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
    let initialized = client.initialize_with_capabilities(
        Value::Null,
        json!({
            "textDocument": {"publishDiagnostics": {"versionSupport": true}}
        }),
    );
    assert_rpc_ok(&initialized, "initialize a push-diagnostic editor");
    assert!(initialized["result"]["capabilities"]
        .get("diagnosticProvider")
        .is_none());
    client.open_document(&uri, SOURCE);
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut publications = Vec::new();
    let resolved = loop {
        let (response, notifications) = client.request_collecting_notifications(
            "textDocument/hover",
            json!({"textDocument": {"uri": uri}, "position": {"line": 2, "character": 16}}),
        );
        assert_rpc_ok(&response, "hover stays responsive during restore");
        publications.extend(notifications.into_iter().filter(|message| {
            message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri
        }));
        if response["result"].is_object() {
            break response;
        }
        assert!(
            Instant::now() < deadline,
            "the real package must restore: {publications:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(
        publications
            .iter()
            .any(|message| has_code(message, "SLSPC0002")),
        "the SDK target proves a real provisional state existed: {publications:?}"
    );
    let latest = publications
        .last()
        .expect("a diagnostic publication precedes semantic resolution");
    assert!(
        !has_code(latest, "SLSPC0002"),
        "pending notices clear before the first binding hover"
    );
    assert!(
        !has_code(latest, "SLSPC0001"),
        "successful restore never leaves terminal degradation"
    );
    assert!(
        latest["params"]["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| {
                diagnostics
                    .iter()
                    .all(|diagnostic| diagnostic["severity"] != 1)
            }),
        "a resolved external type cannot coexist with phantom compiler errors: {latest}"
    );
    assert_eq!(resolved["result"]["contents"]["kind"], "markdown");
    assert!(resolved["result"]["contents"]["value"]
        .as_str()
        .is_some_and(|value| value.contains("JsonConvert")));
    assert_eq!(
        resolved["result"]["range"]["start"],
        json!({"line": 2, "character": 12})
    );
    assert_eq!(
        resolved["result"]["range"]["end"],
        json!({"line": 2, "character": 23})
    );
    client.save_document(&uri);
    let completion = position_request(&mut client, "textDocument/completion", &uri, (2, 24));
    assert_rpc_ok(
        &completion,
        "the restored package remains usable after save",
    );
    assert!(completion["result"]
        .as_array()
        .is_some_and(|items| { items.iter().any(|item| item["label"] == "SerializeObject") }));
    client.shutdown_and_exit();
}
