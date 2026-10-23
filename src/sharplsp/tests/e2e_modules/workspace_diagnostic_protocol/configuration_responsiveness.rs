//! Real live analyzer policy changes must not freeze a warm F# editing session.
//! Implements [DIAG-ANALYSIS-CANCELLATION] and [CONFIG-RESOLUTION].
use super::*;

#[test]
fn live_configuration_during_real_workspace_scan_keeps_fsharp_hover_responsive() {
    let workspace = loaded_workspace();
    let mut client = initialized(&workspace);
    let mut traffic = Vec::new();
    workspace_diagnostic_session::warm_clean_documents(&workspace, &mut client, &mut traffic);
    for enabled in [false, true] {
        let scan_id = next_id();
        client.send(&json!({"jsonrpc":"2.0","id":scan_id,"method":"workspace/diagnostic","params":{"previousResultIds":[],"partialResultToken":"cancelled-scan"}}));
        first_partial(&mut client, scan_id, &mut traffic);
        let changed_at = Instant::now();
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":{"sharplsp":{"diagnostics":{"analyzers_enabled":enabled}}}}),
        );
        assert_warm_hover(&workspace, &mut client, &mut traffic);
        let terminal = cancellation_response(&mut client, scan_id, &mut traffic);
        assert_superseded(&terminal);
        assert!(changed_at.elapsed() < Duration::from_secs(5), "configuration and unrelated warm F# hover cannot wait for a full 128-document compiler scan");
        let configuration = observed_request(
            &mut client,
            "sharplsp/configuration",
            json!({}),
            &mut traffic,
        );
        assert_eq!(
            configuration["result"]["diagnostics"]["analyzers_enabled"],
            enabled
        );
        let uri = path_to_file_uri(&workspace.root.join("Core/Broken.cs"));
        assert_fresh(&mut client, &uri, &mut traffic);
    }
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// A warmed independent F# compiler must continue serving real semantic answers.
fn assert_warm_hover(
    workspace: &fixtures_medium::MediumWorkspace,
    client: &mut LspClient,
    traffic: &mut Vec<Value>,
) {
    let position = fixtures_medium::fs_med_pos::PRODUCT_TYPE;
    let hover = observed_request(
        client,
        "textDocument/hover",
        json!({"textDocument":{"uri":path_to_file_uri(&workspace.domain_path())},"position":{"line":position.0,"character":position.1}}),
        traffic,
    );
    assert!(
        !hover["result"].is_null(),
        "unrelated F# hover remains available: {hover}"
    );
    assert_eq!(hover["result"]["contents"]["kind"], "markdown");
    assert!(hover["result"]["contents"]["value"]
        .as_str()
        .is_some_and(|text| text.contains("Product")));
}
