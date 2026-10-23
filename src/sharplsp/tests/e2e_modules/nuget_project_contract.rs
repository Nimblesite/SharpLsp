//! Actual SDK project selection and rejected package edits. [NUGET-REQUESTS-TARGET-ENUMERATE]
use super::*;

/// Both actual SDK project owners, with F# checked first.
const PROJECTS: [(&str, &str); 2] = [
    ("FsDomain/FsDomain.fsproj", "fsharp"),
    ("Core/Core.csproj", "csharp"),
];

#[test]
fn selected_solution_targets_and_missing_package_edits_preserve_real_sdk_projects() {
    require_dotnet();
    let workspace = fixtures_medium::create_medium_workspace();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    assert_rpc_ok(
        &client.initialize_with_root(json!(workspace.root_uri())),
        "initialize SDK solution",
    );
    for (project, language) in PROJECTS {
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

/// [NUGET-XML-DOM]: absent mutation ownership must preserve actual SDK projects.
#[test]
fn disabled_compiler_package_edits_preserve_real_sdk_projects() {
    require_dotnet();
    let workspace = fixtures_medium::create_medium_workspace();
    let mut client = package_client_without_compilers(&workspace);
    for (project, language) in PROJECTS {
        let path = workspace.root.join(project);
        workspace_diagnostic_support::assert_build(&path, None);
        let before = std::fs::read(&path).expect("read actual SDK project");
        reject_unavailable_edits(&mut client, &path);
        assert_eq!(
            std::fs::read(&path).expect("read unchanged project"),
            before
        );
        assert_selected_target(&mut client, &workspace.root, &path, language);
        workspace_diagnostic_support::assert_build(&path, None);
    }
    client.shutdown_and_exit();
}

/// Use the documented user configuration, with no transport or compiler mocks.
fn package_client_without_compilers(workspace: &fixtures_medium::MediumWorkspace) -> LspClient {
    std::fs::write(
        workspace.root.join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n",
    )
    .expect("disable compiler sidecars explicitly");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    assert_rpc_ok(
        &client.initialize_with_root(json!(workspace.root_uri())),
        "initialize actual SDK solution with compilers disabled",
    );
    client
}

/// Repeated install/uninstall attempts must neither mutate nor start a restore.
fn reject_unavailable_edits(client: &mut LspClient, project: &Path) {
    for action in ["install", "uninstall"] {
        let (response, traffic) = client.request_collecting_notifications(
            &format!("sharplsp/nuget/{action}"),
            json!({"projectPath":project,
                "packageId":"Newtonsoft.Json","version":"13.0.3"}),
        );
        assert_unavailable_package_editor(&response);
        assert!(traffic
            .iter()
            .all(|message| message["method"] != "sharplsp/nuget/restoreProgress"));
    }
}

/// The native protocol exposes an actionable error, without invented changed files.
fn assert_unavailable_package_editor(response: &Value) {
    assert_rpc_ok(response, "disabled compiler remains an actionable result");
    assert_eq!(response["result"]["success"], false);
    assert_eq!(
        response["result"]["message"],
        "C# sidecar is not available to edit project files (open a workspace first)"
    );
    assert!(response["result"].get("modifiedFiles").is_none());
}

/// [NUGET-FEEDBACK-RESTORE]: an unavailable CLI reports failure without losing real edits.
#[test]
fn failed_restore_spawn_preserves_real_sdk_package_edits_and_recovers() {
    require_dotnet();
    let (workspace, props, saved) = imported_props_workspace();
    let target = nuget_restore::props_target(&props, "Imported SDK properties");
    let mut client = client_without_restore_command(&workspace);
    for action in ["install", "uninstall"] {
        let messages = nuget_restore::edit_props(&mut client, &target, &props, action);
        let messages = nuget_restore::await_failed_restore(&mut client, messages);
        let reason = nuget_restore::assert_failed_restore_progress(&messages, &props);
        assert!(
            reason
                .as_str()
                .is_some_and(|message| message.starts_with("spawn failed:")),
            "the editor sees an actual command-start failure: {reason}"
        );
        nuget_restore::assert_installed_package_state(&mut client, &target, action);
        verify_projects_unchanged_and_build(&workspace, &saved);
    }
    client.shutdown_and_exit();
}

/// The props file is imported by both SDK languages, whose original sources build.
fn imported_props_workspace() -> (fixtures_medium::MediumWorkspace, PathBuf, [Vec<u8>; 2]) {
    let workspace = fixtures_medium::create_medium_workspace();
    let props = workspace.root.join("Directory.Build.props");
    std::fs::write(&props, "<Project />\n").expect("write actual imported MSBuild properties");
    let saved = PROJECTS.map(|(relative, _)| {
        let path = workspace.root.join(relative);
        workspace_diagnostic_support::assert_build(&path, None);
        std::fs::read(path).expect("read original SDK project")
    });
    (workspace, props, saved)
}

/// Only the server child's executable search is empty; real absolute sidecar apphosts remain.
fn client_without_restore_command(workspace: &fixtures_medium::MediumWorkspace) -> LspClient {
    let empty = workspace.root.join("without-tools");
    std::fs::create_dir(&empty).expect("create actual empty command search directory");
    let mut client = LspClient::spawn_in_with_env(
        Stdio::null(),
        Some(&workspace.root),
        &[("PATH", empty.as_os_str())],
    );
    assert_rpc_ok(
        &client.initialize_with_root(json!(workspace.root_uri())),
        "initialize SDK workspace with an unavailable restore command",
    );
    client
}

/// A healthy SDK independently recovers each committed edit without changing either project.
fn verify_projects_unchanged_and_build(
    workspace: &fixtures_medium::MediumWorkspace,
    saved: &[Vec<u8>; 2],
) {
    for ((relative, _), before) in PROJECTS.iter().zip(saved) {
        let path = workspace.root.join(relative);
        assert_eq!(
            std::fs::read(&path)
                .expect("read unchanged SDK project")
                .as_slice(),
            before.as_slice()
        );
        workspace_diagnostic_support::assert_build(&path, None);
    }
}
