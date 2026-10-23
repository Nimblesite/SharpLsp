//! Real startup failures remain diagnosable. [SIDECAR-STARTUP-HANDSHAKE] [CONFIG-RESOLUTION]
use super::*;

/// A genuine installed apphost with its managed application missing exits before READY.
fn broken_sidecar(client_root: &std::path::Path, key: &str) -> PathBuf {
    let source = std::env::var_os(key).expect("the real published sidecar is configured");
    let directory = client_root.join("incomplete-installation");
    std::fs::create_dir(&directory).expect("create isolated broken installation");
    let destination = directory.join("sidecar.exe");
    let copied = std::fs::copy(source, &destination)
        .expect("copy the actual apphost without its managed files");
    assert!(copied > 0, "the actual apphost copy must not be empty");
    destination
}

/// Semantic failures must not break syntax navigation or amplify into a spawn storm.
fn assert_degraded_session(client: &mut LspClient, uri: &str, line: u32, column: u32) {
    for _ in 0..3 {
        let hover = position_request(client, "textDocument/hover", uri, (line, column));
        assert_rpc_ok(&hover, "failed sidecar hover");
        assert_eq!(hover["result"], Value::Null);
        let configuration = client.request("sharplsp/configuration", json!({}));
        assert_rpc_ok(
            &configuration,
            "host configuration survives failed child startup",
        );
        assert!(configuration["result"]["testing"]["configuration"].is_string());
        let folds = document_request(client, "textDocument/foldingRange", uri);
        assert_rpc_ok(&folds, "syntax folding survives failed child startup");
        assert!(!folds["result"]
            .as_array()
            .expect("folding result")
            .is_empty());
    }
    assert_unavailable_tokens(client, uri);
}

/// Failed or unavailable analysis must never become a cached clean result. [DIAG-LSP-PULL]
fn assert_unavailable_diagnostics(client: &mut LspClient, uri: &str) {
    for _ in 0..2 {
        let response = document_request(client, "textDocument/diagnostic", uri);
        assert_eq!(
            response["error"]["code"], -32802,
            "unavailable compiler: {response}"
        );
        assert_eq!(response["error"]["data"]["retriggerRequest"], true);
        assert!(
            response.get("result").is_none(),
            "no false clean report: {response}"
        );
        assert!(response["error"]["message"]
            .as_str()
            .is_some_and(|message| !message.is_empty()));
    }
}

/// Highlight requests recover with no result while their real engine cannot start.
fn assert_unavailable_tokens(client: &mut LspClient, uri: &str) {
    for (method, params) in [
        (
            "textDocument/semanticTokens/full",
            json!({"textDocument":{"uri":uri}}),
        ),
        (
            "textDocument/semanticTokens/range",
            json!({"textDocument":{"uri":uri},"range":{"start":{"line":0,"character":0},"end":{"line":1,"character":0}}}),
        ),
        (
            "textDocument/semanticTokens/full/delta",
            json!({"textDocument":{"uri":uri},"previousResultId":"previous-editor-session"}),
        ),
    ] {
        let response = client.request(method, params);
        assert_rpc_ok(&response, method);
        assert_eq!(
            response["result"],
            Value::Null,
            "unavailable engine cannot produce valid highlight data"
        );
    }
}

#[test]
fn actual_sidecar_apphosts_missing_managed_files_degrade_without_respawn_storms() {
    require_dotnet();
    let fsharp = create_fsharp_test_workspace();
    let csharp = create_test_workspace();
    for ((workspace, root, uri, source), language, key, other, cursor) in [
        (
            &fsharp,
            "fsharp",
            "SHARPLSP_FSHARP_SIDECAR_PATH",
            "csharp",
            (5, 8),
        ),
        (
            &csharp,
            "csharp",
            "SHARPLSP_CSHARP_SIDECAR_PATH",
            "fsharp",
            (9, 16),
        ),
    ] {
        let binary = broken_sidecar(workspace.path(), key);
        std::fs::write(
            workspace.path().join("sharplsp.toml"),
            format!("[{other}]\nenabled=false\n"),
        )
        .expect("disable the other language engine");
        let log = tempfile::NamedTempFile::new()
            .expect("capture structured host and runtime diagnostics");
        let started = Instant::now();
        let mut client = LspClient::spawn_in_with_env(
            Stdio::from(log.reopen().expect("open host log")),
            Some(workspace.path()),
            &[
                (key, binary.as_os_str()),
                ("RUST_LOG", std::ffi::OsStr::new("info")),
            ],
        );
        assert_rpc_ok(
            &client.initialize_with_capabilities(
                json!(root),
                json!({
                    "textDocument":{"diagnostic":{"dynamicRegistration":false}},
                    "workspace":{"diagnostics":{"refreshSupport":true}}
                }),
            ),
            "initialize an incomplete sidecar installation",
        );
        client.notify(
            "textDocument/didOpen",
            json!({"textDocument":{"uri":uri,"languageId":language,"version":1,"text":source}}),
        );
        assert_degraded_session(&mut client, uri, cursor.0, cursor.1);
        let unavailable_uri = if language == "fsharp" {
            &csharp.2
        } else {
            &fsharp.2
        };
        assert_unavailable_diagnostics(&mut client, unavailable_uri);
        assert_unavailable_diagnostics(&mut client, uri);
        client.shutdown_and_exit();
        let output = std::fs::read_to_string(log.path()).expect("read failed startup evidence");
        assert!(
            output.contains("sidecar exited before READY"),
            "a real child exit is explained: {output}"
        );
        let attempts = output.matches("Sidecar process spawned").count();
        assert!(attempts > 0, "the genuine apphost was launched");
        // A slow scheduler may legitimately cross a retry boundary; even then every
        // retry must wait at least the first one-second backoff, never per request.
        let allowed =
            1 + usize::try_from(started.elapsed().as_secs()).expect("elapsed seconds fit");
        assert!(
            attempts <= allowed,
            "failed startup must throttle retries: {output}"
        );
        assert!(
            output.contains("delay_ms=1000"),
            "the first failed spawn arms its backoff"
        );
        assert!(
            output.contains("sidecar spawn in backoff"),
            "subsequent requests respect recovery backoff: {output}"
        );
        assert!(output.contains("SharpLsp LSP shut down cleanly"));
    }
}

#[test]
fn invalid_real_workspace_configuration_exits_with_a_diagnostic_and_failure_status() {
    require_dotnet();
    let (workspace, root, _, _) = create_fsharp_test_workspace();
    std::fs::write(
        workspace.path().join("sharplsp.toml"),
        "[testing]\nconfiguration='Release;Rebuild'\n",
    )
    .expect("write invalid workspace policy");
    let log = tempfile::NamedTempFile::new().expect("host error log");
    let mut client = LspClient::spawn_in(
        Stdio::from(log.reopen().expect("open log")),
        Some(workspace.path()),
    );
    assert_rpc_ok(
        &client.initialize_with_root(json!(root)),
        "the LSP transport initializes before configuration validation",
    );
    let _ = client.stdin.take();
    let status = client
        .child
        .wait_timeout(Duration::from_secs(30))
        .expect("wait for startup failure")
        .expect("invalid startup must terminate");
    assert!(!status.success());
    assert_eq!(status.code(), Some(1));
    let output = std::fs::read_to_string(log.path()).expect("read startup failure");
    assert!(
        output.contains("SharpLsp LSP exited with error"),
        "host failure must be visible: {output}"
    );
    assert!(output.contains("testing.configuration must be a nonempty MSBuild configuration name"));
    assert!(
        !output.contains("Sidecar process spawned"),
        "invalid configuration must fail before starting engines"
    );
}
