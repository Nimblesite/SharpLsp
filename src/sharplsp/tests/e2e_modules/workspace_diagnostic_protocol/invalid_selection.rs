//! Invalid selected targets cannot broaden native watching to unrelated directories.
//! Implements [DIAG-ARCHITECTURE-SCOPE] and [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
use super::*;

#[test]
fn missing_selected_solution_does_not_watch_or_refresh_for_its_unrelated_parent() {
    let (workspace, root, _, _) = create_fsharp_test_workspace();
    std::fs::write(
        workspace.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n",
    )
    .expect("disable compiler engines for the native watch scope contract");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
    let response = client.initialize_with_capabilities(json!(root), json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}));
    assert_rpc_ok(
        &response,
        "initialize a real F# workspace without compiler sidecars",
    );
    let missing = workspace.path().join("DoesNotExist.sln");
    assert!(
        !missing.exists(),
        "the selected solution is genuinely absent"
    );
    let mut traffic = Vec::new();
    let selected = observed_request(
        &mut client,
        "sharplsp/loadSolution",
        json!({"solutionPath":missing}),
        &mut traffic,
    );
    assert_eq!(
        selected["result"]["success"], true,
        "selection remains an acknowledged asynchronous request"
    );
    std::thread::sleep(Duration::from_secs(3));
    let _baseline = observed_request(
        &mut client,
        "sharplsp/configuration",
        json!({}),
        &mut traffic,
    );
    traffic.clear();
    let source = workspace.path().join("TestFSharp/Library.fs");
    std::fs::write(&source, BROKEN_FS).expect("edit only the unrelated real F# project's source");
    assert_build(
        &workspace.path().join("TestFSharp/TestFSharp.fsproj"),
        Some("FS0001"),
    );
    std::thread::sleep(Duration::from_secs(3));
    let config = observed_request(
        &mut client,
        "sharplsp/configuration",
        json!({}),
        &mut traffic,
    );
    assert_eq!(config["result"]["fsharp"]["enabled"], false);
    assert_eq!(config["result"]["csharp"]["enabled"], false);
    assert!(!traffic.iter().any(|message| message["method"] == "workspace/diagnostic/refresh"), "a nonexistent selection must not watch its unrelated parent and invalidate on genuine SDK source edits: {traffic:?}");
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}
