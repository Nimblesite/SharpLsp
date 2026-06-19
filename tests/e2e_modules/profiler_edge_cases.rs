use super::profiler_full_stack::{start_profiler_session, stop_profile_target};
use super::*;

// ── Profiler Edge Case Tests ─────────────────────────────────────

/// Edge case: double-stop the same trace session must error on second stop.
#[test]
fn test_profiler_edge_double_stop_trace() {
    let (mut target, target_pid, mut client) = start_profiler_session();

    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let trace_path = tmp_dir
        .path()
        .join("double-stop.nettrace")
        .to_string_lossy()
        .to_string();

    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({
            "pid": target_pid,
            "output_path": trace_path,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "startTrace must succeed: {resp}"
    );
    let session_id = resp["result"]["session_id"].as_str().unwrap();

    std::thread::sleep(Duration::from_secs(1));

    // First stop: must succeed.
    let resp1 = client.request(
        "sharplsp/profiler/stopTrace",
        json!({ "session_id": session_id }),
    );
    assert!(
        resp1.get("error").is_none(),
        "first stopTrace must succeed: {resp1}"
    );

    // Second stop: must error (session already stopped).
    let resp2 = client.request(
        "sharplsp/profiler/stopTrace",
        json!({ "session_id": session_id }),
    );
    assert!(
        resp2.get("error").is_some(),
        "second stopTrace must error: {resp2}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}

/// Edge case: start trace, then kill the target process, then stop — must not hang.
#[test]
fn test_profiler_edge_trace_target_dies() {
    let (mut target, target_pid, mut client) = start_profiler_session();

    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let trace_path = tmp_dir
        .path()
        .join("target-dies.nettrace")
        .to_string_lossy()
        .to_string();

    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({
            "pid": target_pid,
            "output_path": trace_path,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "startTrace must succeed: {resp}"
    );
    let session_id = resp["result"]["session_id"].as_str().unwrap();

    // Kill the target while trace is running.
    stop_profile_target(&mut target);
    std::thread::sleep(Duration::from_millis(500));

    // stopTrace must complete without hanging (server must not deadlock).
    let start = Instant::now();
    let resp = client.request(
        "sharplsp/profiler/stopTrace",
        json!({ "session_id": session_id }),
    );
    let elapsed = start.elapsed();

    // Must not hang.
    assert!(
        elapsed < Duration::from_secs(10),
        "stopTrace must not hang, took {elapsed:?}"
    );

    // When the target died and no trace data was captured, stop must return
    // an error — not a silent success with file_size_bytes=0.
    if let Some(result) = resp.get("result") {
        let size = result["file_size_bytes"].as_u64().unwrap_or(0);
        assert!(
            size > 0,
            "stopTrace must not silently succeed with 0-byte trace; \
             should return an error when no data was captured: {resp}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Edge case: starting a trace on a non-.NET process must fail fast at
/// `startTrace` time — not register a zombie session that only surfaces the
/// failure when the user later clicks Stop (at which point the error is the
/// confusing "session already stopped").
///
/// Repro for the user-reported bug: macOS `dotnet-trace ps` over-reports
/// non-.NET processes (Node, system daemons, Electron helpers, etc.). When
/// the user picked one of those, `dotnet-trace collect` exited immediately
/// with `ServerNotAvailableException` and we silently registered a session
/// anyway. Stop later reported "session already stopped" because the dead
/// child had been taken on a prior stop attempt.
#[test]
fn test_profiler_edge_start_trace_rejects_non_dotnet_pid() {
    // A shell subprocess is guaranteed not to be a .NET runtime, and we own
    // its lifetime so the test is deterministic.
    let mut non_dotnet = std::process::Command::new("sleep")
        .arg("60")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("failed to spawn sleep");
    let non_dotnet_pid = non_dotnet.id();

    let mut client = LspClient::start();
    let _ = client.initialize();

    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let trace_path = tmp_dir
        .path()
        .join("non-dotnet.nettrace")
        .to_string_lossy()
        .to_string();

    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({
            "pid": non_dotnet_pid,
            "output_path": trace_path,
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "startTrace against non-.NET PID must fail at start time, not register \
         a zombie session: {resp}"
    );
    let msg = resp["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.to_lowercase().contains("attach") || msg.to_lowercase().contains("not a .net"),
        "error must explain the attach failure, not be a generic wrapper: {msg}"
    );
    assert!(
        !msg.contains("already stopped"),
        "must not surface the zombie-session path: {msg}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
    let _ = non_dotnet.kill();
    let _ = non_dotnet.wait();
}

/// Edge case: `listProcesses` finds `ProfileTarget` by name in the process list.
#[test]
fn test_profiler_edge_process_list_finds_target_by_name() {
    let (mut target, target_pid, mut client) = start_profiler_session();

    let resp = client.request("sharplsp/profiler/listProcesses", json!({}));
    let processes = resp["result"].as_array().expect("result must be array");

    let entry = processes
        .iter()
        .find(|p| p["pid"].as_u64() == Some(u64::from(target_pid)));
    assert!(entry.is_some(), "must find target by PID");

    let entry = entry.unwrap();
    let name = entry["name"].as_str().unwrap_or("");
    assert!(
        name.contains("ProfileTarget"),
        "process name must contain 'ProfileTarget', got: {name}"
    );
    let cmd = entry["command_line"].as_str().unwrap_or("");
    assert!(
        cmd.contains("ProfileTarget"),
        "command_line must contain 'ProfileTarget', got: {cmd}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}

/// Edge case: max concurrent sessions enforcement.
#[test]
fn test_profiler_edge_max_concurrent_sessions() {
    let (mut target, target_pid, mut client) = start_profiler_session();

    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let mut session_ids = Vec::new();

    // Start 5 trace sessions (the default max).
    for i in 0..5 {
        let trace_path = tmp_dir
            .path()
            .join(format!("max-{i}.nettrace"))
            .to_string_lossy()
            .to_string();

        let resp = client.request(
            "sharplsp/profiler/startTrace",
            json!({
                "pid": target_pid,
                "output_path": trace_path,
            }),
        );
        assert!(
            resp.get("error").is_none(),
            "session {i} must start: {resp}"
        );
        session_ids.push(resp["result"]["session_id"].as_str().unwrap().to_string());
    }

    // 6th session must be rejected.
    let trace_path = tmp_dir
        .path()
        .join("max-overflow.nettrace")
        .to_string_lossy()
        .to_string();
    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({
            "pid": target_pid,
            "output_path": trace_path,
        }),
    );
    assert!(
        resp.get("error").is_some(),
        "6th session must be rejected: {resp}"
    );
    let err_msg = resp["error"]["message"].as_str().unwrap_or("");
    assert!(
        err_msg.contains("limit"),
        "error must mention session limit: {err_msg}"
    );

    // Clean up all sessions.
    for sid in &session_ids {
        let _ = client.request("sharplsp/profiler/stopTrace", json!({ "session_id": sid }));
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}

/// Edge case: analyzeHeap with type filter returns only matching types.
#[test]
fn test_profiler_edge_analyze_heap_type_filter() {
    let (mut target, target_pid, mut client) = start_profiler_session();

    // Collect a dump first.
    let tmp_dir = tempfile::tempdir().expect("create temp dir");
    let dump_path = tmp_dir
        .path()
        .join("filter-test.dmp")
        .to_string_lossy()
        .to_string();

    let resp = client.request(
        "sharplsp/profiler/collectDump",
        json!({
            "pid": target_pid,
            "dump_type": "Heap",
            "output_path": dump_path,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "collectDump must succeed: {resp}"
    );

    // Analyze with filter for "String".
    let resp = client.request(
        "sharplsp/profiler/analyzeHeap",
        json!({
            "dump_path": dump_path,
            "type_filter": "String",
            "limit": 100,
        }),
    );
    assert!(
        resp.get("error").is_none(),
        "analyzeHeap must succeed: {resp}"
    );
    let types = resp["result"]["types"]
        .as_array()
        .expect("types must be array");
    assert!(!types.is_empty(), "filtered result must not be empty");

    // Every returned type must contain "String" (case-insensitive filter).
    for t in types {
        let name = t["type_name"].as_str().unwrap_or("");
        assert!(
            name.to_lowercase().contains("string"),
            "filtered type must contain 'String', got: {name}"
        );
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
    stop_profile_target(&mut target);
}
