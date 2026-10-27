//! Real SDK analyzer configuration applies to the first successful workspace pull.
//! Implements [DIAG-CATEGORIES-ANALYZER] and [CONFIG-RESOLUTION].
use super::*;

const ANALYZER_SOURCE: &str =
    "namespace Medium.Core;\npublic class AnalyzerProbe {\n public int Compute() => 42;\n}\n";

#[test]
fn initial_analyzer_opt_out_and_live_opt_in_apply_to_real_closed_source() {
    let workspace = analyzer_workspace();
    let mut client = initialized(&workspace);
    let uri = path_to_file_uri(&workspace.root.join("Core/AnalyzerProbe.cs"));
    let broken_uri = path_to_file_uri(&workspace.root.join("Core/Broken.cs"));
    let mut traffic = Vec::new();
    assert_analyzer_state(&mut client, &uri, &broken_uri, false, &mut traffic);
    for enabled in [true, false] {
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":{"sharplsp":{"diagnostics":{"analyzers_enabled":enabled}}}}),
        );
        assert_analyzer_state(&mut client, &uri, &broken_uri, enabled, &mut traffic);
    }
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Real SDK files configure an independently reproducible analyzer error.
pub(super) fn analyzer_workspace() -> fixtures_medium::MediumWorkspace {
    let workspace = broken_workspace();
    for (path, source) in [
        ("Core/AnalyzerProbe.cs", ANALYZER_SOURCE),
        (
            ".editorconfig",
            "root=true\n[*.cs]\ndotnet_diagnostic.CA1822.severity=error\n",
        ),
        ("sharplsp.toml", "[diagnostics]\nanalyzers_enabled=false\n"),
    ] {
        std::fs::write(workspace.root.join(path), source)
            .expect("write actual SDK analyzer fixture");
    }
    assert_sdk_analyzer(&workspace);
    workspace
}

/// Confirm the actual SDK emits CA1822 before testing the LSP's opt-out.
fn assert_sdk_analyzer(workspace: &fixtures_medium::MediumWorkspace) {
    let oracle = Command::new("dotnet")
        .args(["build", "--no-restore", "--nologo", "-v:minimal"])
        .current_dir(workspace.root.join("Core"))
        .arg("Core.csproj")
        .output()
        .expect("run actual SDK analyzer");
    assert!(!oracle.status.success());
    assert!(
        String::from_utf8_lossy(&oracle.stdout).contains("CA1822"),
        "real SDK must independently confirm analyzer error: {}",
        String::from_utf8_lossy(&oracle.stdout)
    );
}

/// Never accept a transient incorrect success and wait for a later corrected result.
pub(super) fn assert_analyzer_state(
    client: &mut LspClient,
    uri: &str,
    broken_uri: &str,
    enabled: bool,
    traffic: &mut Vec<Value>,
) {
    let response = complete_workspace_pull(client, traffic);
    let items = response["result"]["items"]
        .as_array()
        .expect("real closed-source reports");
    let diagnostics = full_items(report_for(items, uri));
    assert_eq!(
        diagnostics.iter().any(|item| item["code"] == "CA1822"),
        enabled,
        "first successful report must honor analyzer state {enabled}: {response}"
    );
    assert_error(
        full_items(report_for(items, broken_uri)),
        "CS0029",
        "sharplsp-csharp",
    );
}

/// Full reports retain a nonempty cache identity even when analyzers are disabled.
fn full_items(report: &Value) -> &[Value] {
    assert_eq!(report["kind"], "full");
    assert!(report["resultId"].as_str().is_some_and(|id| !id.is_empty()));
    report["items"]
        .as_array()
        .expect("real compiler diagnostics")
}
