//! Unopened real Razor SDK components participate in workspace pulls and disk repairs.
//! [RAZOR-FEATURES-DIAGNOSTICS] [DIAG-LSP-PULL] [DIAG-TRUTH-GUARANTEES]
use super::*;
use workspace_diagnostic_support::{assert_error, assert_no_push, observed_request, report_for};

/// A component discovered by the SDK's default glob, without explicit `AdditionalFiles`.
const CLOSED: &[&str] = &["BlazorApp", "Components", "Pages", "ClosedError.razor"];
/// Complete valid Razor syntax with one independently confirmed C# type error.
const BROKEN: &str = "<h1>Closed</h1>\n@code {\n private int Broken => \"oops\";\n}\n";
/// The same component with a valid property value.
const FIXED: &str = "<h1>Closed</h1>\n@code {\n private int Broken => 42;\n}\n";

#[test]
fn unopened_real_razor_sdk_components_report_mapped_errors_and_clear_after_disk_repairs() {
    let workspace = fixture();
    let uri = path_to_file_uri(&workspace.file(CLOSED));
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    let initial = workspace_pull(&mut client, &[], &mut traffic);
    let previous = assert_closed_error(&initial, &uri);
    repair(&workspace, &mut client, &uri);
    let repaired = await_clean(&mut client, &previous, &uri, &mut traffic);
    assert_repaired(&repaired, &previous, &uri);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Restore the actual Blazor/Razor/F# solution and let `MSBuild` confirm the source error.
fn fixture() -> RazorWorkspace {
    require_dotnet();
    let workspace = create_razor_workspace_with_latest_sdk();
    std::fs::write(workspace.file(CLOSED), BROKEN).expect("write unopened SDK component");
    workspace_diagnostic_support::assert_build(
        &workspace.file(&["BlazorApp", "BlazorApp.csproj"]),
        Some("CS0029"),
    );
    workspace
}

/// Warm an unrelated clean component; the faulty component is never opened.
fn initialized(workspace: &RazorWorkspace) -> LspClient {
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.root()));
    let response = client.initialize_with_capabilities(
        json!(path_to_file_uri(workspace.root())),
        json!({
            "textDocument":{"diagnostic":{"dynamicRegistration":false}},
            "workspace":{"diagnostics":{"refreshSupport":false}}
        }),
    );
    assert_rpc_ok(&response, "initialize actual RazorSDK workspace");
    assert_eq!(
        response["result"]["capabilities"]["diagnosticProvider"]["workspaceDiagnostics"],
        true
    );
    let counter = &["BlazorApp", "Components", "Pages", "Counter.razor"];
    let uri = workspace.uri(counter);
    client.open_document(&uri, &workspace.text(counter));
    let hover = poll_hover_until_ready(&mut client, &uri, 7, 35, Duration::from_mins(3));
    assert!(hover["contents"]["value"]
        .as_str()
        .is_some_and(|text| text.contains("currentCount")));
    client
}

/// Exercise the standard modern workspace request using the canonical request pump.
fn workspace_pull(client: &mut LspClient, previous: &[Value], traffic: &mut Vec<Value>) -> Value {
    observed_request(
        client,
        "workspace/diagnostic",
        json!({"previousResultIds":previous}),
        traffic,
    )
}

/// A default-globbed unopened component has exactly one mapped compiler-error report.
fn assert_closed_error(response: &Value, uri: &str) -> Vec<Value> {
    let items = response["result"]["items"]
        .as_array()
        .expect("workspace reports");
    let closed = report_for(items, uri);
    assert_eq!(closed["kind"], "full");
    assert!(closed["resultId"].as_str().is_some_and(|id| !id.is_empty()));
    assert_error(
        closed["items"].as_array().expect("mapped Razor errors"),
        "CS0029",
        "sharplsp-razor",
    );
    items
        .iter()
        .map(|item| json!({"uri":item["uri"],"value":item["resultId"]}))
        .collect()
}

/// Prove the compiler's own clean result before notifying the live host of the disk edit.
fn repair(workspace: &RazorWorkspace, client: &mut LspClient, uri: &str) {
    std::fs::write(workspace.file(CLOSED), FIXED).expect("repair unopened SDK component");
    workspace_diagnostic_support::assert_build(
        &workspace.file(&["BlazorApp", "BlazorApp.csproj"]),
        None,
    );
    client.notify(
        "workspace/didChangeWatchedFiles",
        json!({"changes":[{"uri":uri,"type":2}]}),
    );
}

/// Watched-file work is asynchronous; only a full report with explicit absence is clean.
fn await_clean(
    client: &mut LspClient,
    previous: &[Value],
    uri: &str,
    traffic: &mut Vec<Value>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let response = workspace_pull(client, previous, traffic);
        let items = response["result"]["items"]
            .as_array()
            .expect("updated workspace reports");
        let closed = report_for(items, uri);
        if closed["kind"] == "full"
            && closed["items"]
                .as_array()
                .is_some_and(|items| items.iter().all(|item| item["severity"] != 1))
        {
            return response;
        }
        assert!(
            Instant::now() < deadline,
            "closed Razor error did not clear: {closed}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A disk repair changes the identity and explicitly retires the mapped error.
fn assert_repaired(response: &Value, previous: &[Value], uri: &str) {
    let closed = report_for(
        response["result"]["items"]
            .as_array()
            .expect("repaired workspace reports"),
        uri,
    );
    let old = previous
        .iter()
        .find(|item| item["uri"] == uri)
        .expect("initial component identity");
    assert_eq!(closed["kind"], "full");
    assert_ne!(closed["resultId"], old["value"]);
    assert!(closed["resultId"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(closed["items"]
        .as_array()
        .expect("explicit repaired diagnostics")
        .iter()
        .all(|item| item["severity"] != 1));
}

/// Unavailable compiler ownership cannot be memoized as a clean Razor document.
#[test]
fn unowned_razor_diagnostics_fail_until_actual_solution_selection() {
    let target = fixture();
    let other = create_razor_workspace_with_fsharp_built();
    let mut client = initialized(&other);
    let uri = path_to_file_uri(&target.file(CLOSED));
    let mut traffic = Vec::new();
    let (missing, messages) = client.request_collecting_notifications(
        "textDocument/diagnostic",
        json!({"textDocument":{"uri":uri}}),
    );
    traffic.extend(messages);
    assert_unavailable(&missing);
    select_razor_owner(&mut client, &target, &mut traffic);
    let selected = document_pull(&mut client, &uri, &mut traffic);
    assert_document_error(&selected);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// First successful owner-scoped truth has the SDK-confirmed mapped C# error.
fn assert_document_error(response: &Value) {
    assert_rpc_ok(
        response,
        "selected Razor owner reports actual compiler truth",
    );
    assert_eq!(response["result"]["kind"], "full");
    assert!(response["result"]["resultId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert_error(
        response["result"]["items"]
            .as_array()
            .expect("mapped Razor errors"),
        "CS0029",
        "sharplsp-razor",
    );
}

/// Exercise the standard document request without an editor open or semantic rescue.
fn document_pull(client: &mut LspClient, uri: &str, traffic: &mut Vec<Value>) -> Value {
    workspace_diagnostic_support::completed_pull(
        client,
        "textDocument/diagnostic",
        json!({"textDocument":{"uri":uri}}),
        traffic,
    )
}

/// The retryable standard error contains no fabricated clean report or result identity.
fn assert_unavailable(response: &Value) {
    assert_eq!(response["jsonrpc"], "2.0");
    assert!(response["id"].is_number());
    workspace_diagnostic_support::assert_superseded(response);
}

/// Select the actual SDK solution through the same user command as an editor.
fn select_razor_owner(
    client: &mut LspClient,
    workspace: &RazorWorkspace,
    traffic: &mut Vec<Value>,
) {
    let selected = observed_request(
        client,
        "sharplsp/loadSolution",
        json!({"solutionPath":workspace.file(&["RazorFixtures.slnx"])}),
        traffic,
    );
    assert_rpc_ok(&selected, "select actual Razor owner");
    assert_eq!(selected["result"]["success"], true);
}
