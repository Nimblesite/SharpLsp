//! Lost native observations cannot freeze real compiler truth. [DIAG-LSP-REFRESH]
//! Both closed languages repair and regress without restarting any process. [DIAG-TRUTH-GUARANTEES]
use super::*;

#[path = "../../../../../lspkit/test-support/native_overflow.rs"]
mod native_overflow;
#[path = "../../../../../lspkit/test-support/stopped_process.rs"]
mod stopped_process;

#[test]
fn native_queue_overflow_repairs_and_regresses_closed_compiler_truth_without_restart() {
    let workspace = broken_workspace();
    let noise = workspace.root.join("ignored-native-noise");
    std::fs::create_dir(&noise).expect("create irrelevant watched directory");
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    let original = complete_workspace_pull(&mut client, &mut traffic);
    let uris = closed_uris(&workspace);
    workspace_diagnostic_session::assert_closed_reports(items(&original), &uris);
    let pids = owned_compilers(&client);
    let repaired = repair_after_loss(
        &workspace,
        &noise,
        &mut client,
        &uris,
        &original,
        &mut traffic,
    );
    regress_after_loss(
        &workspace,
        &noise,
        &mut client,
        &uris,
        &repaired,
        &mut traffic,
    );
    assert_eq!(
        owned_compilers(&client),
        pids,
        "no compiler restart can rescue observation loss"
    );
    assert!(client.child.try_wait().expect("same native host").is_none());
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

fn closed_uris(workspace: &fixtures_medium::MediumWorkspace) -> [String; 2] {
    [
        path_to_file_uri(&workspace.calculations_path()),
        path_to_file_uri(&workspace.root.join("Core/Broken.cs")),
    ]
}

fn owned_compilers(client: &LspClient) -> [sysinfo::Pid; 2] {
    [
        "SHARPLSP_FSHARP_SIDECAR_PATH",
        "SHARPLSP_CSHARP_SIDECAR_PATH",
    ]
    .map(|key| {
        let executable = recovery::published_apphost_uri(key, "actual compiler apphost");
        recovery::owned_apphost(client, &executable, "one owned real compiler")
    })
}

fn items(response: &Value) -> &[Value] {
    response["result"]["items"]
        .as_array()
        .expect("actual workspace reports")
}

fn previous(response: &Value) -> Vec<Value> {
    items(response)
        .iter()
        .map(|item| json!({"uri":item["uri"],"value":item["resultId"]}))
        .collect()
}

fn lose_inputs(
    workspace: &fixtures_medium::MediumWorkspace,
    noise: &std::path::Path,
    client: &LspClient,
    clean: bool,
) {
    let runtime = tokio::runtime::Runtime::new().expect("native state observation runtime");
    let stopped = runtime.block_on(stopped_process::suspend(
        client.child.id(),
        Duration::from_secs(20),
    ));
    native_overflow::saturate(noise, if clean { "repair" } else { "regression" });
    write_truth(workspace, clean);
    stopped.resume();
}

fn write_truth(workspace: &fixtures_medium::MediumWorkspace, clean: bool) {
    let fsharp = if clean {
        fixtures_medium::CALCULATIONS_FS
    } else {
        BROKEN_FS
    };
    std::fs::write(workspace.calculations_path(), fsharp)
        .expect("save closed F# input after overflow");
    std::fs::write(
        workspace.root.join("Core/Broken.cs"),
        if clean { FIXED_CS } else { BROKEN_CS },
    )
    .expect("save closed C# input after overflow");
    assert_build(
        &workspace.root.join("FsDomain/FsDomain.fsproj"),
        (!clean).then_some("FS0001"),
    );
    assert_build(
        &workspace.root.join("Core/Core.csproj"),
        (!clean).then_some("CS0029"),
    );
}

fn repair_after_loss(
    workspace: &fixtures_medium::MediumWorkspace,
    noise: &std::path::Path,
    client: &mut LspClient,
    uris: &[String; 2],
    original: &Value,
    traffic: &mut Vec<Value>,
) -> Value {
    let since = traffic.len();
    lose_inputs(workspace, noise, client, true);
    let repaired = workspace_diagnostic_session::poll_repaired(
        client,
        &previous(original),
        uris,
        traffic,
        since,
    );
    workspace_diagnostic_session::assert_repaired(&repaired, items(original), uris);
    repaired
}

fn regress_after_loss(
    workspace: &fixtures_medium::MediumWorkspace,
    noise: &std::path::Path,
    client: &mut LspClient,
    uris: &[String; 2],
    repaired: &Value,
    traffic: &mut Vec<Value>,
) {
    let since = traffic.len();
    lose_inputs(workspace, noise, client, false);
    let report = workspace_diagnostic_session::poll_current_reports(
        client,
        &previous(repaired),
        traffic,
        since,
        |items| errors_returned(items, uris),
    );
    workspace_diagnostic_session::assert_closed_reports(items(&report), uris);
    for uri in uris {
        assert_ne!(
            report_for(items(&report), uri)["resultId"],
            report_for(items(repaired), uri)["resultId"]
        );
    }
}

fn errors_returned(items: &[Value], uris: &[String; 2]) -> bool {
    uris.iter().zip(["FS0001", "CS0029"]).all(|(uri, code)| {
        let item = report_for(items, uri);
        item["kind"] == "full"
            && item["items"].as_array().is_some_and(|diagnostics| {
                diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == code)
            })
    })
}
