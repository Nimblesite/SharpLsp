//! Live refresh timing controls actual SDK source input bursts and standard RPC coalescing.
//! Implements [DIAG-ARCHITECTURE-PULL-REFRESH] and [DIAG-CONFIG].
use super::*;

#[test]
fn live_refresh_debounce_coalesces_real_fsharp_input_bursts_at_the_selected_delay() {
    let (workspace, source, mut client) = watching_fsharp();
    let path = workspace.path().join("TestFSharp/Library.fs");
    let mut traffic = Vec::new();
    for milliseconds in [100_u64, 1000, 100] {
        configure_delay(&mut client, milliseconds, &mut traffic);
        idle_restore::drain_for(&mut client, Duration::from_secs(3), &mut traffic);
        traffic.clear();
        assert_burst(&mut client, milliseconds, &path, &source, &mut traffic);
    }
    assert_build(&workspace.path().join("TestFSharp/TestFSharp.fsproj"), None);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

#[test]
fn invalid_refresh_controls_preserve_the_default_and_last_valid_live_policy() {
    let (_workspace, _source, mut client) = watching_fsharp();
    let mut traffic = Vec::new();
    assert_delay(&mut client, 2000, &mut traffic);
    assert_rejected_controls(&mut client, 2000, &mut traffic);
    configure_delay(&mut client, 100, &mut traffic);
    assert_rejected_controls(&mut client, 100, &mut traffic);
    assert_no_push(&traffic);
    client.shutdown_and_exit();
}

/// Canonical restored F# inputs and the same native-only compiler configuration.
fn watching_fsharp() -> (tempfile::TempDir, String, LspClient) {
    let (workspace, root, _, source) = create_fsharp_test_workspace();
    std::fs::write(
        workspace.path().join("sharplsp.toml"),
        "[csharp]\nenabled=false\n[fsharp]\nenabled=false\n",
    )
    .expect("use a genuine SDK workspace without semantic engines");
    let mut client = LspClient::spawn_in(Stdio::null(), Some(workspace.path()));
    let initialized = client.initialize_with_capabilities(json!(root), json!({"textDocument":{"diagnostic":{}},"workspace":{"diagnostics":{"refreshSupport":true}}}));
    assert_rpc_ok(&initialized, "initialize native refresh timing session");
    (workspace, source, client)
}

/// Three genuine disk writes are one burst; the final complete source is unchanged.
fn assert_burst(
    client: &mut LspClient,
    milliseconds: u64,
    path: &Path,
    source: &str,
    traffic: &mut Vec<Value>,
) {
    for contents in [source, BROKEN_FS, source] {
        std::fs::write(path, contents).expect("write a real compiled F# project input");
        std::thread::sleep(Duration::from_millis(20));
    }
    let changed_at = Instant::now();
    assert_one_refresh(client, milliseconds, changed_at, traffic);
    assert_eq!(
        std::fs::read_to_string(path).expect("read final SDK input"),
        source
    );
}

/// A valid live setting is authoritative rather than silently rejected or ignored.
fn configure_delay(client: &mut LspClient, milliseconds: u64, traffic: &mut Vec<Value>) {
    client.notify(
        "workspace/didChangeConfiguration",
        json!({"settings":{"sharplsp":{"diagnostics":{"refresh_debounce_ms":milliseconds}}}}),
    );
    assert_delay(client, milliseconds, traffic);
}

/// Configuration validation retains the exact active timing value and other layers.
fn assert_delay(client: &mut LspClient, milliseconds: u64, traffic: &mut Vec<Value>) {
    let config = observed_request(client, "sharplsp/configuration", json!({}), traffic);
    assert_eq!(
        config["result"]["diagnostics"]["refresh_debounce_ms"], milliseconds,
        "the specified refresh debounce must be a validated live control: {config}"
    );
    assert_eq!(config["result"]["fsharp"]["enabled"], false);
    assert_eq!(config["result"]["csharp"]["enabled"], false);
}

/// The filesystem event quiet period precedes the independently selected diagnostic debounce.
fn assert_one_refresh(
    client: &mut LspClient,
    milliseconds: u64,
    changed_at: Instant,
    traffic: &mut Vec<Value>,
) {
    let elapsed = await_refresh(client, milliseconds, changed_at, traffic);
    assert!(
        elapsed >= Duration::from_millis(if milliseconds == 100 { 80 } else { 900 }),
        "selected delay cannot be skipped: {elapsed:?}"
    );
    idle_restore::drain_for(client, Duration::from_millis(milliseconds + 500), traffic);
    let found = refreshes(traffic);
    assert_eq!(
        found.len(),
        1,
        "one source input burst coalesces into one standard refresh: {traffic:?}"
    );
    assert_eq!(found[0]["jsonrpc"], "2.0");
    assert!(found[0]["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert!(found[0]["params"].is_null());
}

/// Keep the same bounded request pump without retrying or ignoring a successful response.
fn await_refresh(
    client: &mut LspClient,
    milliseconds: u64,
    changed_at: Instant,
    traffic: &mut Vec<Value>,
) -> Duration {
    let deadline =
        changed_at + Duration::from_millis(if milliseconds == 100 { 1500 } else { 3500 });
    while refreshes(traffic).is_empty() {
        assert!(Instant::now() < deadline, "actual input refresh must honor {milliseconds}ms rather than a hardcoded two-second delay: {traffic:?}");
        let _config = observed_request(client, "sharplsp/configuration", json!({}), traffic);
        std::thread::sleep(Duration::from_millis(10));
    }
    changed_at.elapsed()
}

/// Bad scalar types and unknown controls reject the whole attempted override.
fn assert_rejected_controls(client: &mut LspClient, retained: u64, traffic: &mut Vec<Value>) {
    for settings in [
        json!({"refresh_debounce_ms":-1}),
        json!({"refresh_debounce_ms":1.5}),
        json!({"refresh_debounce_ms":"100"}),
        json!({"refresh_debounce_ms":100,"unknown_control":true}),
    ] {
        assert_invalid(
            client,
            "sharplsp/configuration",
            json!({"overrides":{"diagnostics":settings}}),
            traffic,
        );
        client.notify(
            "workspace/didChangeConfiguration",
            json!({"settings":{"sharplsp":{"diagnostics":settings}}}),
        );
        assert_delay(client, retained, traffic);
    }
}

/// Keep complete protocol traffic while counting only negotiated diagnostic refresh requests.
fn refreshes(traffic: &[Value]) -> Vec<&Value> {
    traffic
        .iter()
        .filter(|message| message["method"] == "workspace/diagnostic/refresh")
        .collect()
}
