//! Hidden pending notices must not stop automatic legacy restore convergence.
//! Implements [DIAG-TRUTH-GUARANTEES] and [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
use super::*;

const BROKEN_PACKAGE: &str = "#:package Newtonsoft.Json@13.0.3\nusing Newtonsoft.Json;\nint value = JsonConvert.SerializeObject(new { Answer = 42 });\nSystem.Console.WriteLine(value);\n";

#[test]
fn legacy_error_only_policy_hides_pending_notice_without_losing_restored_compiler_errors() {
    require_dotnet();
    let app = filebased_app();
    std::fs::write(app.path().join("app.cs"), BROKEN_PACKAGE)
        .expect("write actual package compiler error");
    assert_sdk_error(&app);
    let uri = path_to_file_uri(&app.path().join("app.cs"));
    let mut client = LspClient::spawn_in(Stdio::null(), Some(app.path()));
    let initialized = client.initialize_with_capabilities(
        Value::Null,
        json!({"textDocument":{"publishDiagnostics":{"versionSupport":true}}}),
    );
    assert_rpc_ok(&initialized, "initialize error-only legacy editor");
    assert!(initialized["result"]["capabilities"]
        .get("diagnosticProvider")
        .is_none());
    client.notify("workspace/didChangeConfiguration", json!({"settings":{"sharplsp":{"diagnostics":{"min_severity":"error","analyzers_enabled":false}}}}));
    let mut traffic = Vec::new();
    let config = observed_request(
        &mut client,
        "sharplsp/configuration",
        json!({}),
        &mut traffic,
    );
    assert_eq!(config["result"]["diagnostics"]["min_severity"], "error");
    client.open_document(&uri, BROKEN_PACKAGE);
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
    let publication = await_error(&mut client, &uri, &mut traffic);
    assert_error(
        publication["params"]["diagnostics"]
            .as_array()
            .expect("automatic compiler error publication"),
        "CS0029",
        "sharplsp-csharp",
    );
    assert_hidden_notices(&traffic, &uri);
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
    client.shutdown_and_exit();
}

/// The real SDK both restores the external package and independently confirms CS0029.
fn assert_sdk_error(app: &tempfile::TempDir) {
    let output = Command::new("dotnet")
        .args([
            "build",
            "app.cs",
            "--nologo",
            "-v:minimal",
            "--artifacts-path",
        ])
        .arg(app.path().join("artifacts"))
        .current_dir(app.path())
        .output()
        .expect("run real SDK file-based compiler");
    assert!(!output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("CS0029"),
        "SDK must confirm the actual package-dependent type error: {stdout}"
    );
    for marker in ["restore-entered.marker", "restore-completed.marker"] {
        let path = app.path().join(marker);
        assert!(
            path.is_file(),
            "actual SDK must execute the same restore marker {marker}"
        );
        std::fs::remove_file(&path).expect("reset only this fixture's SDK oracle marker");
        assert!(!path.exists());
    }
}

/// No semantic request can rescue a restore loop that discarded its raw pending state.
fn await_error(client: &mut LspClient, uri: &str, traffic: &mut Vec<Value>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(publication) = traffic.iter().rev().find(|message| {
            message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri
                && message["params"]["diagnostics"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["code"] == "CS0029"))
        }) {
            return publication.clone();
        }
        assert!(
            Instant::now() < deadline,
            "error-only policy must still publish final compiler truth automatically: {traffic:?}"
        );
        drain_for(client, Duration::from_millis(100), traffic);
    }
}

/// Filtering controls presentation, while internal pending bookkeeping remains intact.
fn assert_hidden_notices(traffic: &[Value], uri: &str) {
    let publications: Vec<_> = traffic
        .iter()
        .filter(|message| {
            message["method"] == "textDocument/publishDiagnostics"
                && message["params"]["uri"] == uri
        })
        .collect();
    assert!(!publications.is_empty());
    for publication in publications {
        let diagnostics = publication["params"]["diagnostics"]
            .as_array()
            .expect("legacy diagnostic items");
        assert!(
            diagnostics.iter().all(|item| item["severity"] == 1),
            "error-only policy hides informational notices: {publication}"
        );
        assert!(diagnostics
            .iter()
            .all(|item| item["code"] != "SLSPC0002" && item["code"] != "SLSPC0001"));
    }
}
