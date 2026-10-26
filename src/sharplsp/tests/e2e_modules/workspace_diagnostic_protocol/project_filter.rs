//! Real SDK project filters affect workspace scope, never explicit document truth.
//! Implements [DIAG-CONFIG-PROJECT-FILTER] and [DIAG-CONFIG-RELOAD].
use super::*;

const FILTER_CASES: [(&[&str], [bool; 2]); 5] = [
    (&["FsDomain"], [true, false]),
    (&["cOrE/CoRe.CsPrOj"], [false, true]),
    (&["**/FsDomain.fsproj"], [true, false]),
    (&["NoSuchProject"], [false, false]),
    (&[], [true, true]),
];

#[test]
fn project_name_and_path_filters_reconfigure_real_fsharp_and_csharp_workspace_truth() {
    let workspace = broken_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    owned_projects::open_owners(&workspace, &mut client, &mut traffic);
    for (patterns, included) in FILTER_CASES {
        configure_filter(&mut client, patterns, &mut traffic);
        assert_scope(&mut client, &workspace, included, &mut traffic);
        assert_explicit_documents(&mut client, &workspace, &mut traffic);
    }
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

#[test]
fn malformed_project_globs_never_report_false_clean_truth_or_poison_document_pulls() {
    let workspace = broken_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    owned_projects::open_owners(&workspace, &mut client, &mut traffic);
    configure_filter(&mut client, &["["], &mut traffic);
    assert_invalid_filter(&mut client, &mut traffic);
    assert_explicit_documents(&mut client, &workspace, &mut traffic);
    configure_filter(&mut client, &[], &mut traffic);
    assert_scope(&mut client, &workspace, [true, true], &mut traffic);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

fn assert_invalid_filter(client: &mut LspClient, traffic: &mut Vec<Value>) {
    let (response, messages) = target_framework::request_answering(
        client,
        "workspace/diagnostic",
        json!({"previousResultIds":[]}),
    );
    traffic.extend(messages);
    assert_superseded(&response);
}

/// Observe the actual live policy and its standard refresh before pulling again.
fn configure_filter(client: &mut LspClient, patterns: &[&str], traffic: &mut Vec<Value>) {
    let mut changed = Vec::new();
    client.notify(
        "workspace/didChangeConfiguration",
        json!({"settings":{"sharplsp":{
        "diagnostics":{"project_filter":patterns}}}}),
    );
    let configuration = observed_request(client, "sharplsp/configuration", json!({}), &mut changed);
    assert_eq!(
        configuration["result"]["diagnostics"]["project_filter"],
        json!(patterns)
    );
    idle_restore::await_compiler_refresh(client, &mut changed);
    traffic.extend(changed);
}

/// The first successful scan contains exactly the expected closed-source errors.
fn assert_scope(
    client: &mut LspClient,
    workspace: &fixtures_medium::MediumWorkspace,
    included: [bool; 2],
    traffic: &mut Vec<Value>,
) {
    let response = complete_workspace_pull(client, traffic);
    let reports = response["result"]["items"]
        .as_array()
        .expect("workspace reports");
    for ((uri, code, source), expected) in compiler_sources(workspace).into_iter().zip(included) {
        assert_scope_source(reports, (&uri, code, source), expected);
    }
    if !included.into_iter().any(|value| value) {
        assert_eq!(reports, &Vec::<serde_json::Value>::new());
    }
}

fn assert_scope_source(reports: &[Value], (uri, code, source): (&str, &str, &str), expected: bool) {
    assert_eq!(
        reports.iter().any(|item| item["uri"] == uri),
        expected,
        "scope: {reports:?}"
    );
    if expected {
        assert_compiler_report(report_for(reports, uri), code, source);
    }
}

/// Excluded projects still answer explicit pulls with independently SDK-confirmed errors.
fn assert_explicit_documents(
    client: &mut LspClient,
    workspace: &fixtures_medium::MediumWorkspace,
    traffic: &mut Vec<Value>,
) {
    for (uri, code, source) in compiler_sources(workspace) {
        let response = observed_request(
            client,
            "textDocument/diagnostic",
            json!({"textDocument":{"uri":uri}}),
            traffic,
        );
        assert_compiler_report(&response["result"], code, source);
    }
}

fn assert_compiler_report(report: &Value, code: &str, source: &str) {
    assert_eq!(report["kind"], "full");
    assert!(report["resultId"].as_str().is_some_and(|id| !id.is_empty()));
    assert_error(
        report["items"].as_array().expect("compiler truth"),
        code,
        source,
    );
}

/// F# is checked first in every filter transition.
fn compiler_sources(workspace: &fixtures_medium::MediumWorkspace) -> [(String, &str, &str); 2] {
    [
        (
            path_to_file_uri(&workspace.calculations_path()),
            "FS0001",
            "sharplsp-fsharp",
        ),
        (
            path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
            "CS0029",
            "sharplsp-csharp",
        ),
    ]
}
