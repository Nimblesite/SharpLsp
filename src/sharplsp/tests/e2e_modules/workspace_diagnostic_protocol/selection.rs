//! Replace real selected solutions and retire reports from the prior compiler scope.
//! Implements [DIAG-LSP-PULL] and [DIAG-TRUTH-GUARANTEES].
use super::*;

#[test]
fn changing_selected_solution_replaces_closed_errors_and_retires_previous_reports() {
    let first = broken_workspace();
    let second = broken_workspace();
    let mut client = initialized(&first);
    let mut traffic = Vec::new();
    let mut previous = assert_selected(&mut client, &first, &[], &mut traffic);
    for selected in [&second, &first] {
        let response = observed_request(
            &mut client,
            "sharplsp/loadSolution",
            json!({"solutionPath":selected.root.join("Medium.sln")}),
            &mut traffic,
        );
        assert_eq!(response["result"]["success"], true);
        previous = assert_selected(&mut client, selected, &previous, &mut traffic);
    }
    assert_no_push(&traffic);
    assert!(client
        .child
        .try_wait()
        .expect("same native host remains alive")
        .is_none());
    client.shutdown_and_exit();
}

/// First successful compiler truth must belong to the new selection, with explicit retirements.
pub(super) fn assert_selected(
    client: &mut LspClient,
    workspace: &fixtures_medium::MediumWorkspace,
    previous: &[Value],
    traffic: &mut Vec<Value>,
) -> Vec<Value> {
    let response = workspace_pull(client, previous, traffic);
    let items = response["result"]["items"]
        .as_array()
        .expect("selected solution reports");
    let fs_uri = path_to_file_uri(&workspace.calculations_path());
    let cs_uri = path_to_file_uri(&workspace.root.join("Core/Broken.cs"));
    for (uri, code, source) in [
        (&fs_uri, "FS0001", "sharplsp-fsharp"),
        (&cs_uri, "CS0029", "sharplsp-csharp"),
    ] {
        let report = report_for(items, uri);
        assert_eq!(report["kind"], "full");
        assert_error(
            report["items"]
                .as_array()
                .expect("real selected compiler errors"),
            code,
            source,
        );
    }
    assert_retired(items, previous);
    items
        .iter()
        .filter(|item| item["uri"] == fs_uri || item["uri"] == cs_uri)
        .map(|item| {
            assert!(item["resultId"].as_str().is_some_and(|id| !id.is_empty()));
            json!({"uri":item["uri"], "value":item["resultId"]})
        })
        .collect()
}

/// Old diagnostics disappear through explicit empty reports, never an omitted stale owner.
pub(crate) fn assert_retired(items: &[Value], previous: &[Value]) {
    for old in previous {
        let retired = report_for(items, old["uri"].as_str().expect("previous document URI"));
        assert_eq!(retired["kind"], "full");
        assert_eq!(retired["items"], json!([]));
        assert_ne!(retired["resultId"], old["value"]);
    }
}
