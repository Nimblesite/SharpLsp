//! Compiler analyzer opt-out is replayed before the first post-crash diagnostic success.
//! Implements [DIAG-CATEGORIES-ANALYZER] and [SIDECAR-RECOVERY-BACKOFF].
use super::*;
use analyzer_configuration::{analyzer_workspace, assert_analyzer_state};

#[test]
fn csharp_crash_restores_real_analyzer_opt_out_before_first_successful_pull() {
    let workspace = analyzer_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    let uris = [
        path_to_file_uri(&workspace.root.join("Core/AnalyzerProbe.cs")),
        path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
    ];
    assert_analyzer_state(&mut client, &uris[0], &uris[1], false, &mut traffic);
    let original = crash_csharp(&client);
    save_fsharp(&workspace, &mut client);
    assert_analyzer_state(&mut client, &uris[0], &uris[1], false, &mut traffic);
    assert_respawned(&client, original);
    assert_live_policy(&mut client, &uris, &mut traffic);
    assert_host_alive(&mut client);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Kernel identity must change only for the owned Roslyn compiler process.
fn assert_respawned(client: &LspClient, original: sysinfo::Pid) {
    assert_ne!(
        owned_csharp(client),
        original,
        "the actual Roslyn apphost respawns"
    );
}

/// The original editor-facing native server remains alive throughout recovery.
pub(super) fn assert_host_alive(client: &mut LspClient) {
    assert!(client
        .child
        .try_wait()
        .expect("same native host stays alive")
        .is_none());
}

/// The same verified process ownership contract protects both compiler crash cases.
pub(super) fn owned_csharp(client: &LspClient) -> sysinfo::Pid {
    let uri = published_apphost_uri(
        "SHARPLSP_CSHARP_SIDECAR_PATH",
        "actual published C# apphost path",
    );
    owned_apphost(client, &uri, "exactly one owned C# compiler apphost")
}

/// Terminate only this session's actual Roslyn process after initial truth is proven.
pub(super) fn crash_csharp(client: &LspClient) -> sysinfo::Pid {
    let pid = owned_csharp(client);
    crash_owned_pid(client, pid);
    pid
}

/// A real other-language save invalidates Salsa without repairing the crashed engine.
pub(super) fn save_fsharp(workspace: &fixtures_medium::MediumWorkspace, client: &mut LspClient) {
    let path = workspace.domain_path();
    let source = std::fs::read(&path).expect("read independent F# source");
    std::fs::write(&path, source).expect("save independent F# document");
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[{"uri":path_to_file_uri(&path),"type":2}]}),
    );
}

/// The new compiler can still enable and disable the SDK-confirmed analyzer error.
fn assert_live_policy(client: &mut LspClient, uris: &[String; 2], traffic: &mut Vec<Value>) {
    for enabled in [true, false] {
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":{"sharplsp":{"diagnostics":{"analyzers_enabled":enabled}}}}),
        );
        assert_analyzer_state(client, &uris[0], &uris[1], enabled, traffic);
    }
}
