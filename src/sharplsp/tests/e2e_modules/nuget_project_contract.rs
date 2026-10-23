//! Actual SDK project selection and rejected package edits. [NUGET-REQUESTS-TARGET-ENUMERATE]
use super::*;

#[test]
fn selected_solution_targets_and_missing_package_edits_preserve_real_sdk_projects() {
    require_dotnet();
    let workspace = fixtures_medium::create_medium_workspace();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    assert_rpc_ok(
        &client.initialize_with_root(json!(workspace.root_uri())),
        "initialize SDK solution",
    );
    for (project, language) in [
        ("FsDomain/FsDomain.fsproj", "fsharp"),
        ("Core/Core.csproj", "csharp"),
    ] {
        assert_project_roundtrip(&mut client, &workspace.root, project, language);
    }
    client.shutdown_and_exit();
}

fn assert_project_roundtrip(client: &mut LspClient, root: &Path, project: &str, language: &str) {
    let path = root.join(project);
    workspace_diagnostic_support::assert_build(&path, None);
    let before = std::fs::read(&path).expect("read genuine SDK project");
    assert_selected_target(client, root, &path, language);
    reject_missing_edits(client, &root.join("Missing").join(project));
    assert_eq!(
        std::fs::read(&path).expect("read unchanged project"),
        before
    );
    workspace_diagnostic_support::assert_build(&path, None);
}

fn assert_selected_target(client: &mut LspClient, root: &Path, project: &Path, language: &str) {
    let response = client.request(
        "sharplsp/nuget/targets",
        json!({
        "workspaceRoot":root,"solutionProjects":[project,project]}),
    );
    assert_rpc_ok(&response, "enumerate explicitly selected SDK project");
    let targets = response["result"]["targets"]
        .as_array()
        .expect("package targets");
    assert_eq!(
        targets.len(),
        1,
        "unselected projects and duplicate paths are excluded: {response}"
    );
    assert_target_metadata(&targets[0], project, language);
    assert_eq!(response["result"]["defaultTargetId"], json!(project));
    assert_eq!(response["result"]["cpmEnabled"], false);
}

fn assert_target_metadata(target: &Value, project: &Path, language: &str) {
    assert_eq!(target["id"], json!(project));
    assert_eq!(target["path"], json!(project));
    assert_eq!(target["kind"], "project");
    assert_eq!(target["language"], language);
    assert_eq!(
        target["displayName"],
        if language == "fsharp" {
            "FsDomain.fsproj"
        } else {
            "Core.csproj"
        }
    );
}

fn reject_missing_edits(client: &mut LspClient, missing: &Path) {
    for action in ["install", "uninstall"] {
        let (response, traffic) = client.request_collecting_notifications(
            &format!("sharplsp/nuget/{action}"),
            json!({"projectPath":missing,
                "packageId":"Newtonsoft.Json","version":"13.0.3"}),
        );
        assert_rpc_ok(&response, "missing project remains an actionable result");
        assert_eq!(response["result"]["success"], false);
        assert!(response["result"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("target not found")));
        assert!(response["result"].get("modifiedFiles").is_none());
        assert!(traffic
            .iter()
            .all(|message| message["method"] != "sharplsp/nuget/restoreProgress"));
    }
}
