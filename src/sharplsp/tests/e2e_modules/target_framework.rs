use super::*;

// ── Active target framework [NETFX-CONTEXT] ──────────────────────

/// A restored `net48;net10.0` project whose one file holds a member per `#if` branch.
fn create_multi_targeted_workspace() -> (tempfile::TempDir, String, String, String) {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("Probe.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net48;net10.0</TargetFrameworks>
  </PropertyGroup>
</Project>"#,
    )
    .unwrap();
    let source = r#"namespace Fx;

public static class Probe
{
#if NETFRAMEWORK
    public static string OnFramework => "framework";
#else
    public static string OnModern => "modern";
#endif
}
"#;
    std::fs::write(tmp.path().join("Probe.cs"), source).unwrap();
    restore_project(tmp.path());
    let root = std::fs::canonicalize(tmp.path()).unwrap();
    let file_uri = path_to_file_uri(&root.join("Probe.cs"));
    (tmp, path_to_file_uri(&root), file_uri, source.to_string())
}

/// Send `method` and read until ITS response, answering every server request on the
/// way as a client must; returns the response and everything else that arrived.
fn request_answering(client: &mut LspClient, method: &str, params: Value) -> (Value, Vec<Value>) {
    let id = next_id();
    client.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
    let mut arrived = Vec::new();
    loop {
        let message = client.recv();
        if message["id"] == json!(id) && message.get("method").is_none() {
            return (message, arrived);
        }
        if message.get("id").is_some() && message.get("method").is_some() {
            client.send(&json!({ "jsonrpc": "2.0", "id": message["id"], "result": null }));
        }
        arrived.push(message);
    }
}

fn methods(messages: &[Value]) -> Vec<&str> {
    messages
        .iter()
        .filter_map(|message| message["method"].as_str())
        .collect()
}

/// The project answers from its first framework until switched; a switch announces
/// itself and asks for exactly the refreshes the client declared; a bad switch fails.
#[test]
fn test_full_stack_target_framework_switch() {
    require_dotnet();
    let (_tmp, root_uri, file_uri, source) = create_multi_targeted_workspace();
    let mut client = LspClient::start_verbose();
    let refreshes = json!({ "workspace": {
        "semanticTokens": { "refreshSupport": true },
        "inlayHint": { "refreshSupport": true },
        "codeLens": { "refreshSupport": false }
    }});
    let _ = client.initialize_with_capabilities(json!(root_uri), refreshes);
    client.open_document(&file_uri, &source);
    let _ = poll_hover_until_ready(&mut client, &file_uri, 5, 26, Duration::from_mins(2));
    let document = json!({ "textDocument": { "uri": file_uri } });

    let current = client.request("sharplsp/targetFramework", document.clone());
    assert_eq!(
        current["result"]["active"], "net48",
        "the FIRST framework: {current}"
    );
    assert_eq!(current["result"]["available"], json!(["net48", "net10.0"]));
    let project = current["result"]["project"].as_str().unwrap();
    assert!(
        project.ends_with("Probe.csproj"),
        "the project answered about: {project}"
    );

    let switch = json!({ "textDocument": { "uri": file_uri }, "targetFramework": "net10.0" });
    let (switched, arrived) = request_answering(&mut client, "sharplsp/setTargetFramework", switch);
    assert_eq!(
        switched["result"]["active"], "net10.0",
        "the switch answers: {switched}"
    );
    let announced = arrived
        .iter()
        .find(|message| message["method"] == "sharplsp/targetFrameworkChanged")
        .unwrap_or_else(|| panic!("a switch is announced: {arrived:?}"));
    assert_eq!(announced["params"]["active"], "net10.0");
    assert_eq!(announced["params"]["textDocument"]["uri"], json!(file_uri));
    let asked = methods(&arrived);
    assert!(
        asked.contains(&"workspace/semanticTokens/refresh"),
        "{asked:?}"
    );
    assert!(asked.contains(&"workspace/inlayHint/refresh"), "{asked:?}");
    assert!(
        !asked.contains(&"workspace/codeLens/refresh"),
        "not declared: {asked:?}"
    );
    let after = client.request("sharplsp/targetFramework", document);
    assert_eq!(after["result"]["active"], "net10.0");

    let unknown = json!({ "textDocument": { "uri": file_uri }, "targetFramework": "net99.0" });
    let refused = client.request("sharplsp/setTargetFramework", unknown);
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("net99.0"),
        "{refused}"
    );
    let bare = json!({ "textDocument": { "uri": file_uri } });
    let missing = client.request("sharplsp/setTargetFramework", bare);
    let reason = missing["error"]["message"].as_str().unwrap();
    assert!(reason.contains("requires targetFramework"), "{missing}");

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
