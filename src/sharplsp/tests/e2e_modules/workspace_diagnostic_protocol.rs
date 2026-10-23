//! Real compiler sessions reject stale snapshots and malformed pulls. [DIAG-LSP-PULL]
//! Implements [DIAG-ANALYSIS-CANCELLATION] and [DIAG-TRUTH-GUARANTEES].
use super::*;
use workspace_diagnostic_interruption::*;
use workspace_diagnostic_support::*;

mod analyzer_configuration;
mod configuration_responsiveness;
mod idle_restore;
mod initialization;
mod input_reload;
mod invalid_selection;
mod owned_projects;
mod project_filter;
mod recovery;
mod refresh_debounce;
mod selection;

/// Retry explicitly superseded work; inspect the first successful real compiler report.
fn complete_workspace_pull(client: &mut LspClient, traffic: &mut Vec<Value>) -> Value {
    workspace_pull(client, &[], traffic)
}

/// Preserve previous-result tokens through explicitly superseded workspace scans.
fn workspace_pull(client: &mut LspClient, previous: &[Value], traffic: &mut Vec<Value>) -> Value {
    completed_pull(
        client,
        "workspace/diagnostic",
        json!({"previousResultIds":previous}),
        traffic,
    )
}

#[test]
fn an_edit_supersedes_a_streamed_workspace_scan_without_mislabeling_old_truth() {
    let workspace = loaded_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    let scan_id = next_id();
    client.send(
        &json!({"jsonrpc":"2.0","id":scan_id,"method":"workspace/diagnostic",
        "params":{"previousResultIds":[],"partialResultToken":"cancelled-scan"}}),
    );
    first_partial(&mut client, scan_id, &mut traffic);
    let uri = path_to_file_uri(&workspace.entities_path());
    client.change_document(&uri, 2, CHANGED_SOURCE);
    let terminal = cancellation_response(&mut client, scan_id, &mut traffic);
    assert_superseded(&terminal);
    assert_fresh(&mut client, &uri, &mut traffic);
    assert_no_stale_chunks(
        &traffic,
        traffic
            .iter()
            .position(|message| message == &terminal)
            .expect("terminal recorded"),
        &uri,
    );
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

#[test]
fn malformed_pulls_and_unknown_cancellations_do_not_poison_real_compiler_sessions() {
    let workspace = broken_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    for (method, params) in [
        ("textDocument/diagnostic", json!({"textDocument":null})),
        (
            "workspace/diagnostic",
            json!({"previousResultIds":"invalid"}),
        ),
    ] {
        assert_invalid(&mut client, method, params, &mut traffic);
        client.notify("$/cancelRequest", json!({"id":next_id()}));
        let uri = path_to_file_uri(&workspace.root.join("Core/Broken.cs"));
        assert_fresh(&mut client, &uri, &mut traffic);
    }
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Modern pull negotiation on the real mixed F#/C# solution.
fn initialized(workspace: &fixtures_medium::MediumWorkspace) -> LspClient {
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let response = client.initialize_with_capabilities(
        json!(workspace.root_uri()),
        json!({
            "textDocument":{"diagnostic":{"dynamicRegistration":false}},
            "workspace":{"diagnostics":{"refreshSupport":true}}
        }),
    );
    assert_rpc_ok(&response, "initialize protocol recovery session");
    client
}

/// A subsequent valid request must produce the independently confirmed compiler error.
fn assert_fresh(client: &mut LspClient, uri: &str, traffic: &mut Vec<Value>) {
    let fresh = observed_request(
        client,
        "textDocument/diagnostic",
        json!({"textDocument":{"uri":uri}}),
        traffic,
    );
    assert_eq!(fresh["result"]["kind"], "full");
    assert!(fresh["result"]["resultId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert_error(
        fresh["result"]["items"]
            .as_array()
            .expect("current compiler diagnostics"),
        "CS0029",
        "sharplsp-csharp",
    );
}

/// Parameter validation leaves the connection and compiler state usable.
fn assert_invalid(client: &mut LspClient, method: &str, params: Value, traffic: &mut Vec<Value>) {
    let (response, messages) = target_framework::request_answering(client, method, params);
    traffic.extend(messages);
    assert_eq!(
        response["error"]["code"], -32602,
        "invalid parameters: {response}"
    );
    assert!(response.get("result").is_none());
    assert!(response["error"]["message"]
        .as_str()
        .is_some_and(|message| !message.is_empty()));
}
