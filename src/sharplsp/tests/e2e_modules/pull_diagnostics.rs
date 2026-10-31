use super::*;

// ── Pull Diagnostics (LSP 3.17) ─────────────────────────────────

/// `textDocument/diagnostic` request must return a valid diagnostic report,
/// not "method not found". This is the pull diagnostics model required by
/// VS Code's web client (`code serve-web`).
#[test]
fn test_pull_diagnostics_document_request_is_handled() {
    // A full report requires actual compiler ownership. [DIAG-TRUTH-GUARANTEES]
    let (_workspace, file_uri, mut client) = fsharp::ready_fsharp_client();

    let resp = client.request(
        "textDocument/diagnostic",
        json!({
            "textDocument": { "uri": file_uri }
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "textDocument/diagnostic must not return an error, got: {resp}",
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "textDocument/diagnostic must return a diagnostic report",
    );
    let kind = result["kind"].as_str();
    assert!(
        kind == Some("full") || kind == Some("unchanged"),
        "diagnostic report kind must be 'full' or 'unchanged', got: {kind:?}",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `workspace/diagnostic` request must return a valid workspace diagnostic
/// report, not "method not found".
#[test]
fn test_pull_diagnostics_workspace_request_is_handled() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "workspace/diagnostic",
        json!({
            "previousResultIds": []
        }),
    );

    assert_eq!(resp["jsonrpc"], "2.0");
    assert!(
        resp.get("error").is_none(),
        "workspace/diagnostic must not return an error, got: {resp}",
    );
    let result = &resp["result"];
    assert!(
        !result.is_null(),
        "workspace/diagnostic must return a report",
    );
    assert!(
        result["items"].is_array(),
        "workspace/diagnostic must return items array",
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Pull `uri` again while its snapshot is genuinely superseded, as an editor
/// does, and return the first answer that is not.
fn past_supersession(client: &mut LspClient, uri: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_mins(1);
    loop {
        let response = client.request(
            "textDocument/diagnostic",
            json!({ "textDocument": { "uri": uri } }),
        );
        let superseded = response["error"]["data"]["retriggerRequest"] == true;
        if !superseded || std::time::Instant::now() > deadline {
            return response;
        }
    }
}

/// A document the compiler refuses, here an F# file beside its project but not
/// in it, is answered as server-cancelled with the compiler's own cause and no
/// retrigger. Never "ask again now": the answer cannot change until the
/// workspace does, and VS Code asked again at once, 165,000 times in thirteen
/// minutes, until its extension host stopped responding (#527). Never an empty
/// report either, which would claim the file clean. [DIAG-TRUTH-GUARANTEES]
#[test]
fn a_document_the_compiler_refuses_is_never_retriggered() {
    let (workspace, file_uri, mut client) = fsharp::ready_fsharp_client();
    let project = std::fs::canonicalize(workspace.path())
        .unwrap()
        .join("TestFSharp");
    let stray = project.join("Stray.fs");
    let source = "module Stray

let answer = 42
";
    std::fs::write(&stray, source).unwrap();
    let stray_uri = path_to_file_uri(&stray);
    client.open_document(&stray_uri, source);

    for attempt in 1..=2 {
        let refused = past_supersession(&mut client, &stray_uri);
        let error = &refused["error"];
        assert_eq!(
            error["code"], -32802,
            "pull {attempt}: server-cancelled: {refused}"
        );
        assert_eq!(
            error["data"]["retriggerRequest"], false,
            "pull {attempt}: never asked again at once: {refused}"
        );
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|message| message.contains("Stray.fs")),
            "pull {attempt}: carries the compiler's cause: {refused}"
        );
        assert!(
            refused.get("result").is_none(),
            "pull {attempt}: no report claims it clean"
        );
    }

    let mut traffic = Vec::new();
    let owned = workspace_diagnostic_support::completed_pull(
        &mut client,
        "textDocument/diagnostic",
        json!({ "textDocument": { "uri": file_uri } }),
        &mut traffic,
    );
    assert_eq!(
        owned["result"]["kind"], "full",
        "the project's own file still reports: {owned}"
    );
    let pulled = workspace_diagnostic_support::completed_pull(
        &mut client,
        "workspace/diagnostic",
        json!({ "previousResultIds": [] }),
        &mut traffic,
    );
    assert!(
        pulled["result"]["items"]
            .as_array()
            .is_some_and(|items| items
                .iter()
                .all(|item| item["uri"].as_str() != Some(stray_uri.as_str()))),
        "a refused document fails neither the workspace pull nor is reported clean: {pulled}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
