//! Closed-file diagnostics across real F# and C# projects. [DIAG-LSP-PULL]
//! Also implements [DIAG-LSP-CAPABILITIES-EXCLUSIVE] and [DIAG-LSP-REFRESH].
use super::*;
use workspace_diagnostic_support::*;

#[test]
fn workspace_pull_reports_closed_errors_reuses_ids_and_clears_after_disk_repairs() {
    let workspace = broken_workspace();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let initialized = client.initialize_with_capabilities(
        json!(workspace.root_uri()),
        json!({"textDocument":{"diagnostic":{"dynamicRegistration":false}},
            "workspace":{"diagnostics":{"refreshSupport":true}}}),
    );
    assert_rpc_ok(&initialized, "initialize real mixed solution");
    let mut traffic = Vec::new();
    warm_clean_documents(&workspace, &mut client, &mut traffic);
    let response = observed_request(
        &mut client,
        "workspace/diagnostic",
        json!({"previousResultIds":[]}),
        &mut traffic,
    );
    let items = response["result"]["items"]
        .as_array()
        .expect("workspace diagnostic reports");
    let uris = [
        path_to_file_uri(&workspace.calculations_path()),
        path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
    ];
    assert_closed_reports(items, &uris);
    let previous: Vec<Value> = items
        .iter()
        .map(|item| json!({"uri":item["uri"],"value":item["resultId"]}))
        .collect();
    let same = observed_request(
        &mut client,
        "workspace/diagnostic",
        json!({"previousResultIds":previous}),
        &mut traffic,
    );
    assert_unchanged(&same, items);
    let traffic_before_repair = traffic.len();
    repair_workspace(&workspace, &mut client);
    let cleared = poll_repaired(
        &mut client,
        &previous,
        &uris,
        &mut traffic,
        traffic_before_repair,
    );
    assert_repaired(&cleared, items, &uris);
    assert!(
        traffic[traffic_before_repair..]
            .iter()
            .any(|message| message["method"] == "workspace/diagnostic/refresh"),
        "real disk repairs must invalidate client diagnostics"
    );
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

#[test]
fn editor_advertising_both_models_negotiates_pull_without_duplicate_pushes() {
    let workspace = broken_workspace();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let response = client.initialize_with_capabilities(json!(workspace.root_uri()), json!({
        "textDocument":{"diagnostic":{"dynamicRegistration":false},"publishDiagnostics":{"relatedInformation":true}},
        "workspace":{"diagnostics":{"refreshSupport":true}}
    }));
    assert_rpc_ok(&response, "initialize VS Code-shaped client");
    let provider = &response["result"]["capabilities"]["diagnosticProvider"];
    assert_eq!(
        provider["identifier"], "sharplsp",
        "pull must win when both capabilities exist"
    );
    assert_eq!(provider["interFileDependencies"], true);
    assert_eq!(provider["workspaceDiagnostics"], true);
    let mut traffic = Vec::new();
    warm_clean_documents(&workspace, &mut client, &mut traffic);
    let report = observed_request(
        &mut client,
        "workspace/diagnostic",
        json!({"previousResultIds":[]}),
        &mut traffic,
    );
    assert_closed_reports(
        report["result"]["items"].as_array().expect("mixed reports"),
        &[
            path_to_file_uri(&workspace.calculations_path()),
            path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
        ],
    );
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

#[test]
fn legacy_publish_only_editor_receives_closed_errors_and_clears_them_after_disk_repairs() {
    let workspace = broken_workspace();
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let response = client.initialize_with_capabilities(
        json!(workspace.root_uri()),
        json!({
            "textDocument":{"publishDiagnostics":{"relatedInformation":true,"versionSupport":true}}
        }),
    );
    assert_rpc_ok(&response, "initialize legacy publish-only editor");
    assert!(response["result"]["capabilities"]["diagnosticProvider"].is_null());
    let uris = [
        path_to_file_uri(&workspace.calculations_path()),
        path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
    ];
    let mut traffic = Vec::new();
    warm_clean_documents(&workspace, &mut client, &mut traffic);
    poll_pushes(&mut client, &uris, false, &mut traffic);
    for ((uri, code), source) in uris
        .iter()
        .zip(["FS0001", "CS0029"])
        .zip(["sharplsp-fsharp", "sharplsp-csharp"])
    {
        assert_error(
            last_push(&traffic, uri).expect("closed-file push")["params"]["diagnostics"]
                .as_array()
                .expect("push diagnostics"),
            code,
            source,
        );
    }
    repair_workspace(&workspace, &mut client);
    let mut repaired_traffic = Vec::new();
    poll_pushes(&mut client, &uris, true, &mut repaired_traffic);
    for uri in &uris {
        let publication =
            last_push(&repaired_traffic, uri).expect("repair must publish a replacement");
        assert_eq!(publication["params"]["uri"], *uri);
        assert!(publication["params"]["diagnostics"]
            .as_array()
            .expect("clear payload")
            .iter()
            .all(|diagnostic| diagnostic["severity"] != 1));
    }
    client.shutdown_and_exit();
}

/// Latest replacement publication for one document in observed protocol traffic.
fn last_push<'a>(traffic: &'a [Value], uri: &str) -> Option<&'a Value> {
    traffic.iter().rev().find(|message| {
        message["method"] == "textDocument/publishDiagnostics" && message["params"]["uri"] == uri
    })
}

/// Require both real engines to publish the current closed-file state.
fn poll_pushes(
    client: &mut LspClient,
    uris: &[String; 2],
    cleared: bool,
    traffic: &mut Vec<Value>,
) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        // The pull only pumps the pushes; a completed watched-file mutation may
        // correctly supersede it, and the standard retrigger is retried.
        // [DIAG-LSP-REFRESH]
        let _ = completed_pull_before(
            client,
            "workspace/diagnostic",
            json!({"previousResultIds":[]}),
            traffic,
            deadline,
        );
        if uris.iter().all(|uri| {
            last_push(traffic, uri).is_some_and(|message| {
                message["params"]["diagnostics"]
                    .as_array()
                    .is_some_and(|diagnostics| {
                        diagnostics
                            .iter()
                            .any(|diagnostic| diagnostic["severity"] == 1)
                            != cleared
                    })
            })
        }) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "legacy push did not converge (cleared={cleared}): {traffic:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Load F# first and C# second without opening either deliberately broken file.
pub(super) fn warm_clean_documents(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) {
    for (path, source, language, position) in clean_entries(workspace) {
        let uri = path_to_file_uri(&path);
        client.notify(
            "textDocument/didOpen",
            json!({"textDocument":{"uri":uri,"languageId":language,"version":1,"text":source}}),
        );
        let response = observed_request(
            client,
            "textDocument/hover",
            json!({"textDocument":{"uri":uri},"position":{"line":position.0,"character":position.1}}),
            traffic,
        );
        assert!(
            !response["result"].is_null(),
            "actual engine must serve clean document: {response}"
        );
    }
}

/// Both compiler-confirmed errors must appear once without unrelated errors.
pub(super) fn assert_closed_reports(items: &[Value], uris: &[String; 2]) {
    for ((uri, code), source) in uris
        .iter()
        .zip(["FS0001", "CS0029"])
        .zip(["sharplsp-fsharp", "sharplsp-csharp"])
    {
        let report = report_for(items, uri);
        assert_eq!(report["kind"], "full");
        assert!(report["resultId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_error(
            report["items"].as_array().expect("full report items"),
            code,
            source,
        );
    }
    let error_files = items
        .iter()
        .filter(|report| {
            report["items"].as_array().is_some_and(|diagnostics| {
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic["severity"] == 1)
            })
        })
        .count();
    assert_eq!(
        error_files, 2,
        "no false errors in clean solution documents: {items:?}"
    );
}

/// Stable workspace state reuses opaque IDs and omits unchanged payloads.
fn assert_unchanged(response: &Value, original: &[Value]) {
    let items = response["result"]["items"]
        .as_array()
        .expect("unchanged workspace reports");
    assert_eq!(items.len(), original.len());
    for prior in original {
        let item = report_for(items, prior["uri"].as_str().expect("report URI"));
        assert_eq!(item["kind"], "unchanged");
        assert_eq!(item["resultId"], prior["resultId"]);
        assert!(
            item.get("items").is_none(),
            "unchanged report must omit payload"
        );
    }
}

/// Wait for watched disk repairs to replace both stale diagnostic sets.
pub(super) fn poll_repaired(
    client: &mut LspClient,
    previous: &[Value],
    uris: &[String; 2],
    traffic: &mut Vec<Value>,
    refresh_since: usize,
) -> Value {
    poll_current_reports(client, previous, traffic, refresh_since, |items| {
        uris.iter().all(|uri| {
            let item = report_for(items, uri);
            item["kind"] == "full"
                && item["items"].as_array().is_some_and(|diagnostics| {
                    diagnostics
                        .iter()
                        .all(|diagnostic| diagnostic["severity"] != 1)
                })
        })
    })
}

/// Both repair and regression wait for an actual refresh and complete current reports.
pub(super) fn poll_current_reports(
    client: &mut LspClient,
    previous: &[Value],
    traffic: &mut Vec<Value>,
    refresh_since: usize,
    accepts: impl Fn(&[Value]) -> bool,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let report = completed_pull_before(
            client,
            "workspace/diagnostic",
            json!({"previousResultIds":previous}),
            traffic,
            deadline,
        );
        let items = report["result"]["items"]
            .as_array()
            .expect("repair reports");
        let refreshed = traffic[refresh_since..]
            .iter()
            .any(|message| message["method"] == "workspace/diagnostic/refresh");
        if refreshed && accepts(items) {
            return report;
        }
        assert!(
            Instant::now() < deadline,
            "repaired real compiler-clean files retain stale errors: {report}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Changed reports receive new opaque IDs and contain no stale compiler errors.
pub(super) fn assert_repaired(response: &Value, original: &[Value], uris: &[String; 2]) {
    let items = response["result"]["items"]
        .as_array()
        .expect("repaired items");
    for uri in uris {
        let repaired = report_for(items, uri);
        assert_eq!(repaired["kind"], "full");
        assert_ne!(repaired["resultId"], report_for(original, uri)["resultId"]);
        assert!(repaired["resultId"]
            .as_str()
            .is_some_and(|id| !id.is_empty()));
        assert!(repaired["items"]
            .as_array()
            .expect("repaired diagnostics")
            .iter()
            .all(|diagnostic| diagnostic["severity"] != 1));
    }
}
