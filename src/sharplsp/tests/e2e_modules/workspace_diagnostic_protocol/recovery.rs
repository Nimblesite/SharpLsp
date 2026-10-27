//! Real compiler crash recovery preserves closed-file truth and unsaved overlays.
//! Implements [DIAG-TRUTH-GUARANTEES] and [SIDECAR-RECOVERY-BACKOFF].
use super::*;

mod analyzer_replay;
mod generated_input_batches;
mod metadata_independence;

const OVERLAY: &str = "module Medium.FsDomain.Calculations\n\nlet value (_product: Medium.FsDomain.Domain.Product): int = onlyUnsavedDuringRecovery\n";

#[test]
fn fsharp_crash_recovers_selected_solution_and_unsaved_diagnostic_truth() {
    let workspace = recovery_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    let uris = open_unsaved_error(&workspace, &mut client, &mut traffic);
    assert_truth(&mut client, &uris, &mut traffic, "before crash");
    let original_pid = crash_owned_fsharp(&client);
    save_other_language(&workspace, &mut client);
    assert_truth(
        &mut client,
        &uris,
        &mut traffic,
        "after real owned F# crash",
    );
    assert_recovered(&workspace, &mut client, original_pid, &mut traffic);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Persist the same analyzer policy before initializing the real compiler session.
fn recovery_workspace() -> fixtures_medium::MediumWorkspace {
    let workspace = broken_workspace();
    std::fs::write(
        workspace.root.join("sharplsp.toml"),
        "[diagnostics]\nanalyzers_enabled=false\n",
    )
    .expect("persist analyzer opt-out");
    workspace
}

/// Keep saved compiler errors and the distinct unsaved overlay in one real workspace.
fn open_unsaved_error(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) -> [String; 2] {
    workspace_diagnostic_session::warm_clean_documents(workspace, client, traffic);
    client.notify(
        "workspace/didChangeConfiguration",
        json!({"settings":{"sharplsp":{"diagnostics":{"analyzers_enabled":false}}}}),
    );
    let fs_uri = path_to_file_uri(&workspace.calculations_path());
    client.notify(
        "textDocument/didOpen",
        json!({"textDocument":{"uri":fs_uri,"languageId":"fsharp","version":1,"text":BROKEN_FS}}),
    );
    client.change_document(&fs_uri, 2, OVERLAY);
    let cs_uri = path_to_file_uri(&workspace.root.join("Core/Broken.cs"));
    [fs_uri, cs_uri]
}

/// A genuine independent save invalidates the snapshot without repairing the crashed engine.
fn save_other_language(workspace: &fixtures_medium::MediumWorkspace, client: &mut LspClient) {
    let unchanged_source =
        std::fs::read(workspace.entities_path()).expect("read independent C# source");
    std::fs::write(workspace.entities_path(), unchanged_source)
        .expect("save independent C# document");
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[{"uri":path_to_file_uri(&workspace.entities_path()),"type":2}]}),
    );
}

/// Recovery preserves the same host, a new owned compiler and effective configuration.
fn assert_recovered(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    original_pid: sysinfo::Pid,
    traffic: &mut Vec<Value>,
) {
    assert!(client.child.try_wait().expect("host status").is_none());
    assert_ne!(
        owned_fsharp(client),
        original_pid,
        "actual compiler must respawn"
    );
    assert_saved_source(workspace);
    let config = observed_request(client, "sharplsp/configuration", json!({}), traffic);
    assert_eq!(config["result"]["diagnostics"]["analyzers_enabled"], false);
}

/// Successful overlay replay must never mutate the saved source behind the editor.
fn assert_saved_source(workspace: &fixtures_medium::MediumWorkspace) {
    assert_eq!(
        std::fs::read_to_string(workspace.calculations_path()).expect("unchanged saved F# source"),
        BROKEN_FS
    );
}

/// Only an actual compiler child belonging to this test's native host may be stopped.
fn owned_fsharp(client: &LspClient) -> sysinfo::Pid {
    owned_apphost(
        client,
        &published_fsharp_uri(),
        "exactly one owned F# compiler apphost",
    )
}

/// Require both executable and parent identity for either real compiler engine.
pub(in crate::e2e_modules) fn owned_apphost(
    client: &LspClient,
    executable_uri: &str,
    description: &str,
) -> sysinfo::Pid {
    let system = sysinfo::System::new_all();
    let parent = sysinfo::Pid::from_u32(client.child.id());
    let owned: Vec<_> = system
        .processes()
        .values()
        .filter(|process| is_owned_compiler(process, parent, executable_uri))
        .map(sysinfo::Process::pid)
        .collect();
    assert_eq!(owned.len(), 1, "{description}");
    owned[0]
}

/// Compare executable identity through the canonical fixture URI conversion.
fn published_fsharp_uri() -> String {
    published_apphost_uri(
        "SHARPLSP_FSHARP_SIDECAR_PATH",
        "actual published F# apphost path",
    )
}

/// Published apphosts use the same canonical fixture path conversion.
pub(in crate::e2e_modules) fn published_apphost_uri(key: &str, description: &str) -> String {
    let executable = std::env::var_os(key).expect(description);
    canonical_file_uri(std::path::Path::new(&executable))
        .expect("resolve actual published compiler apphost")
}

/// Parent PID and the actual configured apphost must both match before a process can be killed.
fn is_owned_compiler(
    process: &sysinfo::Process,
    parent: sysinfo::Pid,
    executable_uri: &str,
) -> bool {
    process.parent() == Some(parent)
        && process
            .exe()
            .and_then(|path| canonical_file_uri(path).ok())
            .is_some_and(|uri| uri == executable_uri)
}

/// A real crash must leave the editor's native host running.
fn crash_owned_fsharp(client: &LspClient) -> sysinfo::Pid {
    let pid = owned_fsharp(client);
    crash_owned_pid(client, pid);
    pid
}

/// Revalidate parent ownership immediately before terminating this test's actual apphost.
fn crash_owned_pid(client: &LspClient, pid: sysinfo::Pid) {
    let system = sysinfo::System::new_all();
    let process = system.process(pid).expect("owned compiler remains alive");
    assert_eq!(
        process.parent(),
        Some(sysinfo::Pid::from_u32(client.child.id()))
    );
    assert!(process.kill(), "terminate only this session's compiler");
}

/// The first successful report must be truthful; retry only explicitly incomplete requests.
fn assert_truth(client: &mut LspClient, uris: &[String; 2], traffic: &mut Vec<Value>, phase: &str) {
    let [fs_uri, cs_uri] = uris;
    let report = complete_workspace_pull(client, traffic);
    let items = report["result"]["items"]
        .as_array()
        .expect("workspace reports");
    assert!(
        items.iter().any(|item| item["uri"] == fs_uri.as_str()),
        "{phase}: real F# document must remain in selected solution reports: {report}"
    );
    let fs = report_for(items, fs_uri);
    assert_fsharp_overlay(fs);
    let cs = report_for(items, cs_uri);
    assert_eq!(cs["kind"], "full");
    assert_error(
        cs["items"].as_array().expect("closed C# errors"),
        "CS0029",
        "sharplsp-csharp",
    );
}

/// The compiler error must still come from the same distinct unsaved source buffer.
fn assert_fsharp_overlay(fs: &Value) {
    assert_eq!(fs["kind"], "full");
    assert_error(
        fs["items"].as_array().expect("F# errors"),
        "FS0039",
        "sharplsp-fsharp",
    );
    assert!(fs["items"]
        .as_array()
        .expect("overlay errors")
        .iter()
        .any(|item| item["message"]
            .as_str()
            .is_some_and(|message| message.contains("onlyUnsavedDuringRecovery"))));
}
