//! Real partial pulls remain interruptible. [DIAG-ANALYSIS-CANCELLATION]
//! Implements [DIAG-LSP-PULL] and [DIAG-TRUTH-GUARANTEES].
use super::*;
use workspace_diagnostic_support::*;

/// Complete file-local C# declarations remain valid when repeated across real files.
const LOAD_SOURCE: &str = "file static class ScanLoad { public static int Value => 42; }\n";
/// A complete replacement buffer whose own compiler error is unambiguous.
const CHANGED_SOURCE: &str = "namespace Medium.Core;\npublic static class Customer {\n public static int Value => \"changed during scan\";\n}\n";

#[test]
fn cancelling_a_partial_workspace_pull_does_not_block_hover_or_publish_stale_edits() {
    let workspace = broken_workspace();
    for index in 0..128 {
        std::fs::write(
            workspace
                .root
                .join("Core")
                .join(format!("ScanLoad{index:03}.cs")),
            LOAD_SOURCE,
        )
        .expect("write real SDK source file");
    }
    assert_build(&workspace.root.join("Core/Core.csproj"), Some("CS0029"));
    let mut client = LspClient::spawn_in(Stdio::null(), Some(&workspace.root));
    let initialized = client.initialize_with_capabilities(
        json!(workspace.root_uri()),
        json!({
            "textDocument":{"diagnostic":{"dynamicRegistration":false}},
            "workspace":{"diagnostics":{"refreshSupport":true}}
        }),
    );
    assert_rpc_ok(&initialized, "initialize cancellable real mixed solution");
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    let scan_id = next_id();
    client.send(
        &json!({"jsonrpc":"2.0","id":scan_id,"method":"workspace/diagnostic",
        "params":{"previousResultIds":[],"partialResultToken":"cancelled-scan"}}),
    );
    first_partial(&mut client, scan_id, &mut traffic);
    let cancelled_at = Instant::now();
    client.notify("$/cancelRequest", json!({"id":scan_id}));
    let entity_uri = path_to_file_uri(&workspace.entities_path());
    client.change_document(&entity_uri, 2, CHANGED_SOURCE);
    let hover = observed_request(
        &mut client,
        "textDocument/hover",
        json!({
            "textDocument":{"uri":path_to_file_uri(&workspace.domain_path())},
            "position":{"line":fixtures_medium::fs_med_pos::PRODUCT_TYPE.0,"character":fixtures_medium::fs_med_pos::PRODUCT_TYPE.1}
        }),
        &mut traffic,
    );
    assert!(
        !hover["result"].is_null(),
        "unrelated warm F# hover must still answer: {hover}"
    );
    let terminal = cancellation_response(&mut client, scan_id, &mut traffic);
    assert_eq!(
        terminal["error"]["code"], -32800,
        "an in-flight cancelled pull must not complete successfully: {terminal}"
    );
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(5),
        "cancel/edit/hover cannot wait for all 128 unrelated documents"
    );
    let finished_at = traffic
        .iter()
        .position(|message| message["id"] == scan_id && message.get("method").is_none())
        .expect("the cancelled request's terminal response was recorded");
    let fresh = observed_request(
        &mut client,
        "textDocument/diagnostic",
        json!({
            "textDocument":{"uri":entity_uri},"identifier":"sharplsp"
        }),
        &mut traffic,
    );
    assert_eq!(fresh["result"]["kind"], "full");
    assert!(fresh["result"]["resultId"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    assert_error(
        fresh["result"]["items"]
            .as_array()
            .expect("fresh edited diagnostics"),
        "CS0029",
        "sharplsp-csharp",
    );
    assert_no_stale_chunks(&traffic, finished_at, &entity_uri);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Observe the first real streamed report before issuing cancellation.
fn first_partial(client: &mut LspClient, scan_id: i32, traffic: &mut Vec<Value>) {
    loop {
        let message = client.recv();
        if message.get("id").is_some() && message.get("method").is_some() {
            assert_eq!(message["method"], "workspace/diagnostic/refresh");
            client.send(&json!({"jsonrpc":"2.0","id":message["id"],"result":null}));
        }
        assert!(
            !(message["id"] == scan_id && message.get("method").is_none()),
            "partial result must precede completion: {message}"
        );
        let partial =
            message["method"] == "$/progress" && message["params"]["token"] == "cancelled-scan";
        traffic.push(message);
        if partial {
            let items = traffic.last().expect("first progress")["params"]["value"]["items"]
                .as_array()
                .expect("partial items");
            assert_eq!(items.len(), 1, "one document is streamed at a time");
            assert_eq!(items[0]["kind"], "full");
            assert!(items[0]["uri"].as_str().is_some_and(|uri| !uri.is_empty()));
            return;
        }
    }
}

/// Lightweight requests keep pumping the connection while cancellation settles.
fn cancellation_response(client: &mut LspClient, scan_id: i32, traffic: &mut Vec<Value>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(response) = traffic
            .iter()
            .find(|message| message["id"] == scan_id && message.get("method").is_none())
        {
            return response.clone();
        }
        assert!(
            Instant::now() < deadline,
            "workspace cancellation must settle promptly"
        );
        let _ = observed_request(client, "sharplsp/configuration", json!({}), traffic);
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Cancelled progress cannot resume or claim old truth belongs to a newer buffer.
fn assert_no_stale_chunks(traffic: &[Value], finished_at: usize, entity_uri: &str) {
    for (index, message) in traffic.iter().enumerate() {
        if message["method"] != "$/progress" || message["params"]["token"] != "cancelled-scan" {
            continue;
        }
        assert!(
            index < finished_at,
            "a completed cancelled request must never emit another partial result"
        );
        for item in message["params"]["value"]["items"]
            .as_array()
            .expect("streamed reports")
        {
            if item["uri"] == entity_uri && item["version"] == 2 {
                assert_error(
                    item["items"].as_array().expect("new version diagnostics"),
                    "CS0029",
                    "sharplsp-csharp",
                );
            }
        }
    }
}
