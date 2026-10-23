//! Real background restore failures remain visible and recoverable. [NUGET-REQUESTS]
use super::*;

#[test]
fn failed_nuget_restore_reports_progress_and_keeps_package_operations_usable() {
    require_dotnet();
    let (_workspace, root, props, target) = props_only_fixture();
    let mut client = LspClient::start();
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "initialize F# workspace",
    );
    for action in ["install", "uninstall"] {
        let notifications = edit_props(&mut client, &target, &props, action);
        let notifications = await_failed_restore(&mut client, notifications);
        let _ = assert_failed_restore_progress(&notifications, &props);
        assert_installed_package_state(&mut client, &target, action);
    }
    client.shutdown_and_exit();
}

/// A real props target with no project in its own restore directory.
fn props_only_fixture() -> (tempfile::TempDir, String, PathBuf, Value) {
    let (workspace, root, _, _) = create_fsharp_test_workspace();
    let props_dir = workspace.path().join("props-only");
    std::fs::create_dir(&props_dir).expect("create props target directory");
    let props = props_dir.join("Directory.Build.props");
    std::fs::write(&props, "<Project />").expect("write an actual MSBuild props file");
    let target = props_target(&props, "props-only");
    (workspace, root, props, target)
}

/// The same concrete `MSBuild` target used by both failure scenarios.
pub(super) fn props_target(props: &Path, label: &str) -> Value {
    json!({"id":props,"path":props,"kind":"buildProps","displayName":label})
}

/// An XML edit succeeds independently of the background CLI operation.
pub(super) fn edit_props(
    client: &mut LspClient,
    target: &Value,
    props: &Path,
    action: &str,
) -> Vec<Value> {
    let (response, notifications) = client.request_collecting_notifications(
        &format!("sharplsp/nuget/{action}"),
        json!({"target": target, "packageId": "Newtonsoft.Json", "version": "13.0.3"}),
    );
    assert_rpc_ok(&response, action);
    assert_eq!(
        response["result"]["success"], true,
        "the DOM edit succeeded"
    );
    assert_eq!(response["result"]["modifiedFiles"], json!([props]));
    notifications
}

/// Keep the original deadline and responsiveness assertions while awaiting real progress.
pub(super) fn await_failed_restore(
    client: &mut LspClient,
    mut notifications: Vec<Value>,
) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !notifications
        .iter()
        .any(|message| message["params"]["phase"] == "failed")
    {
        assert!(
            Instant::now() < deadline,
            "restore must terminate: {notifications:?}"
        );
        std::thread::sleep(Duration::from_millis(100));
        let (barrier, more) =
            client.request_collecting_notifications("sharplsp/configuration", json!({}));
        assert_rpc_ok(&barrier, "background restore never blocks the LSP");
        notifications.extend(more);
    }
    notifications
}

/// Preserve every phase, identity, notification and terminal-diagnostic assertion.
pub(super) fn assert_failed_restore_progress(notifications: &[Value], props: &Path) -> Value {
    let progress: Vec<&Value> = notifications
        .iter()
        .filter(|message| message["method"] == "sharplsp/nuget/restoreProgress")
        .collect();
    assert_progress_identity(&progress, props);
    let terminal = progress.last().expect("terminal restore notification");
    assert!(
        terminal["params"]["message"]
            .as_str()
            .is_some_and(|message| !message.trim().is_empty()),
        "the failing dotnet command's diagnostic must reach the editor: {progress:?}"
    );
    terminal["params"]["message"].clone()
}

/// Ordered phases are emitted exactly once, for the edited target.
fn assert_progress_identity(progress: &[&Value], props: &Path) {
    let phases: Vec<&Value> = progress
        .iter()
        .map(|message| &message["params"]["phase"])
        .collect();
    assert_eq!(
        phases,
        vec![&json!("started"), &json!("restoring"), &json!("failed")]
    );
    for message in progress {
        assert_eq!(message["params"]["targetId"], json!(props));
        assert!(message.get("id").is_none(), "progress is a notification");
    }
}

/// A failed restore never hides the successfully edited package declarations.
pub(super) fn assert_installed_package_state(client: &mut LspClient, target: &Value, action: &str) {
    let installed = client.request("sharplsp/nuget/installed", json!({"target": target}));
    assert_rpc_ok(
        &installed,
        "package state is readable after restore failure",
    );
    let packages = installed["result"]["packages"]
        .as_array()
        .expect("installed packages");
    assert_eq!(packages.len(), usize::from(action == "install"));
    if action == "install" {
        assert_eq!(packages[0]["id"], "Newtonsoft.Json");
        assert_eq!(packages[0]["requestedVersion"], "13.0.3");
        assert_eq!(packages[0]["resolvedVersion"], "13.0.3");
    }
}
