//! Completed real SDK restore wakes an idle pull client through compiler IPC.
//! Implements [DIAG-IPC-REFRESH] and [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
use super::*;
use filebased_diagnostics::{SOURCE, TARGETS};

mod legacy_policy;

const OBSERVE: &str = r#"<Project>
  <Target Name="MarkRestoreEntered" BeforeTargets="ObservePendingRestore">
    <WriteLinesToFile File="$(MSBuildThisFileDirectory)restore-entered.marker" Lines="entered" Overwrite="true" />
  </Target>
  <Target Name="MarkRestoreCompleted" AfterTargets="Restore">
    <WriteLinesToFile File="$(MSBuildThisFileDirectory)restore-completed.marker" Lines="completed" Overwrite="true" />
  </Target>
</Project>"#;

#[test]
fn compiler_restore_completion_refreshes_idle_client_outside_native_watched_root() {
    require_dotnet();
    let app = filebased_app();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(app.path()));
    let initialized = client.initialize_with_capabilities(Value::Null, json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}));
    assert_rpc_ok(&initialized, "initialize rootless idle pull client");
    let mut traffic = Vec::new();
    client.notify(
        "workspace/didChangeConfiguration",
        json!({"settings":{"sharplsp":{"diagnostics":{"analyzers_enabled":false}}}}),
    );
    let configured = observed_request(
        &mut client,
        "sharplsp/configuration",
        json!({}),
        &mut traffic,
    );
    assert_eq!(configured["result"]["fsharp"]["enabled"], false);
    drain_for(&mut client, Duration::from_secs(3), &mut traffic);
    let uri = path_to_file_uri(&app.path().join("app.cs"));
    traffic.clear();
    client.open_document(&uri, SOURCE);
    await_marker(
        &mut client,
        app.path(),
        "restore-entered.marker",
        &mut traffic,
    );
    await_marker(
        &mut client,
        app.path(),
        "restore-completed.marker",
        &mut traffic,
    );
    assert!(traffic.iter().any(is_refresh), "opening inputs must refresh while the genuine restore target is still pending: {traffic:?}");
    traffic.clear();
    await_compiler_refresh(&mut client, &mut traffic);
    let response = observed_request(
        &mut client,
        "textDocument/diagnostic",
        json!({"textDocument":{"uri":uri}}),
        &mut traffic,
    );
    let diagnostics = response["result"]["items"]
        .as_array()
        .expect("restored compiler truth");
    assert_eq!(response["result"]["kind"], "full");
    assert!(response["result"]["resultId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert!(
        diagnostics.iter().all(|item| item["severity"] != 1
            && item["code"] != "SLSPC0002"
            && item["code"] != "SLSPC0001"),
        "completed real restore must clear provisional state and bind the package: {response}"
    );
    let hover = observed_request(
        &mut client,
        "textDocument/hover",
        json!({"textDocument":{"uri":uri},"position":{"line":2,"character":16}}),
        &mut traffic,
    );
    assert_eq!(hover["result"]["contents"]["kind"], "markdown");
    assert!(hover["result"]["contents"]["value"]
        .as_str()
        .is_some_and(|text| text.contains("JsonConvert")));
    assert_eq!(
        hover["result"]["range"]["start"],
        json!({"line":2,"character":12})
    );
    assert_eq!(
        hover["result"]["range"]["end"],
        json!({"line":2,"character":23})
    );
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Reuse the unchanged SDK package source and slow-target fixture.
fn filebased_app() -> tempfile::TempDir {
    let app = tempfile::tempdir().expect("unwatched sibling file-based app");
    for (path, source) in [
        ("app.cs", SOURCE),
        ("Directory.Build.targets", TARGETS),
        ("Directory.Build.props", OBSERVE),
        ("sharplsp.toml", "[fsharp]\nenabled=false\n"),
    ] {
        std::fs::write(app.path().join(path), source).expect("write actual SDK inputs");
    }
    app
}

/// Requests observe the connection without causing diagnostic analysis or source mutations.
fn drain_for(client: &mut LspClient, duration: Duration, traffic: &mut Vec<Value>) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        let _response = observed_request(client, "sharplsp/configuration", json!({}), traffic);
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Real `MSBuild` writes the marker; no fake SDK or fabricated completion event is involved.
fn await_marker(client: &mut LspClient, root: &Path, marker: &str, traffic: &mut Vec<Value>) {
    let deadline = Instant::now() + Duration::from_mins(1);
    while !root.join(marker).is_file() {
        assert!(
            Instant::now() < deadline,
            "actual SDK did not reach {marker}"
        );
        drain_for(client, Duration::from_millis(100), traffic);
    }
}

/// No client file notification or semantic request can manufacture this second invalidation.
fn await_compiler_refresh(client: &mut LspClient, traffic: &mut Vec<Value>) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !traffic.iter().any(is_refresh) {
        assert!(
            Instant::now() < deadline,
            "completed SDK restore must refresh an idle pull client over compiler IPC: {traffic:?}"
        );
        drain_for(client, Duration::from_millis(100), traffic);
    }
}

/// Only the standard negotiated diagnostic refresh counts as observable invalidation.
fn is_refresh(message: &Value) -> bool {
    message["method"] == "workspace/diagnostic/refresh"
        && message["id"].as_str().is_some_and(|id| !id.is_empty())
}
