use super::*;

// ── Profiler Tests ────────────────────────────────────────────────

/// `forge/profiler/listProcesses` returns a JSON array or tool-not-found error.
#[test]
fn test_profiler_list_processes() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/profiler/listProcesses", json!({}));

    if let Some(error) = resp.get("error") {
        // Tool not installed — acceptable in CI / dev without dotnet tools.
        let msg = error["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("not found"),
            "error must be tool-not-found, got: {msg}"
        );
    } else {
        let result = &resp["result"];
        assert!(result.is_array(), "result must be a JSON array: {result}");

        if let Some(processes) = result.as_array() {
            for proc in processes {
                assert!(proc["pid"].is_u64(), "pid must be a number");
                assert!(proc["name"].is_string(), "name must be a string");
                assert!(proc.get("command_line").is_some(), "command_line field");
            }
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `forge/profiler/startTrace` returns an error for a non-existent PID
/// (tool not found or attach failure — both acceptable, server must not crash).
#[test]
fn test_profiler_start_trace_invalid_pid() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("forge/profiler/startTrace", json!({ "pid": 999_999_999 }));

    // Either error or result is fine — just must not crash.
    assert!(
        resp.get("error").is_some() || resp.get("result").is_some(),
        "must return a response: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `forge/profiler/stopTrace` errors for a non-existent session.
#[test]
fn test_profiler_stop_trace_unknown_session() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/stopTrace",
        json!({ "session_id": "nonexistent-session-id" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for unknown session: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `forge/profiler/stopCounters` errors for a non-existent session.
#[test]
fn test_profiler_stop_counters_unknown_session() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/stopCounters",
        json!({ "session_id": "nonexistent-session-id" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for unknown session: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `forge/profiler/analyzeHeap` errors for a nonexistent dump file.
#[test]
fn test_profiler_analyze_heap_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/analyzeHeap",
        json!({ "dump_path": "/nonexistent/path/to/dump.dmp" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `forge/profiler/findGCRoots` errors for a nonexistent dump file.
#[test]
fn test_profiler_find_gc_roots_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/findGCRoots",
        json!({
            "dump_path": "/nonexistent/path/to/dump.dmp",
            "object_address": "0x00007ff800001111"
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Profiler Performance Benchmarks ──────────────────────────────

/// Benchmark: `forge/profiler/listProcesses` completes within 500ms.
#[test]
fn test_profiler_list_processes_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request("forge/profiler/listProcesses", json!({}));
    let elapsed = start.elapsed();

    assert!(
        resp.get("result").is_some() || resp.get("error").is_some(),
        "must return result or error: {resp}"
    );
    assert!(
        elapsed < Duration::from_millis(500),
        "listProcesses took {elapsed:?}, target <500ms"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: `forge/profiler/startTrace` responds within 1s (even for invalid PID).
#[test]
fn test_profiler_start_trace_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request("forge/profiler/startTrace", json!({ "pid": 999_999_999 }));
    let elapsed = start.elapsed();

    assert!(
        resp.get("result").is_some() || resp.get("error").is_some(),
        "must return result or error: {resp}"
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "startTrace took {elapsed:?}, target <1s"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: counter stop responds within 100ms.
#[test]
fn test_profiler_counter_stop_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "forge/profiler/stopCounters",
        json!({ "session_id": "bench-nonexistent" }),
    );
    let elapsed = start.elapsed();

    assert!(
        resp.get("error").is_some(),
        "must error for unknown session: {resp}"
    );
    assert!(
        elapsed < Duration::from_millis(100),
        "stopCounters took {elapsed:?}, target <100ms"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: `forge/profiler/analyzeHeap` error path responds within 5s.
#[test]
fn test_profiler_analyze_heap_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "forge/profiler/analyzeHeap",
        json!({ "dump_path": "/nonexistent/benchmark.dmp" }),
    );
    let elapsed = start.elapsed();

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "analyzeHeap took {elapsed:?}, target <5s"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: `forge/profiler/findGCRoots` error path responds within 10s.
#[test]
fn test_profiler_find_gc_roots_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "forge/profiler/findGCRoots",
        json!({
            "dump_path": "/nonexistent/benchmark.dmp",
            "object_address": "0x00007ff800001111"
        }),
    );
    let elapsed = start.elapsed();

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "findGCRoots took {elapsed:?}, target <10s"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

// ── Error path tests ─────────────────────────────────────────────

/// Error path: inspectObject on a nonexistent dump file must error.
#[test]
fn test_profiler_inspect_object_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/inspectObject",
        json!({
            "dump_path": "/nonexistent/path/to/dump.dmp",
            "object_address": "0x12345678",
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Error path: diffHeapSnapshots with a nonexistent baseline dump must error.
#[test]
fn test_profiler_diff_heap_snapshots_missing_baseline() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": "/nonexistent/baseline.dmp",
            "comparison_dump_path": "/nonexistent/comparison.dmp",
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing baseline dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Error path: diffHeapSnapshots with a nonexistent comparison dump must error.
#[test]
fn test_profiler_diff_heap_snapshots_missing_comparison() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Create a real temp file for baseline but missing comparison.
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let baseline = tmp.path().to_string_lossy().to_string();

    let resp = client.request(
        "forge/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": baseline,
            "comparison_dump_path": "/nonexistent/comparison.dmp",
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing comparison dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Error path: getObjectGraph with a nonexistent dump file must error.
#[test]
fn test_profiler_get_object_graph_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "forge/profiler/getObjectGraph",
        json!({
            "dump_path": "/nonexistent/path/to/dump.dmp",
            "root_address": "0x00007ff812345678",
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Error path: diffHeapSnapshots does not crash the server.
#[test]
fn test_profiler_diff_heap_snapshots_server_survives_error() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    // Send bad request.
    let _ = client.request(
        "forge/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": "/no/such/file.dmp",
            "comparison_dump_path": "/no/such/file2.dmp",
        }),
    );

    // Server must still respond to subsequent requests.
    let resp2 = client.request("forge/profiler/listProcesses", json!({}));
    assert!(
        resp2.get("error").is_none() || resp2.get("result").is_some(),
        "server must still respond after diffHeapSnapshots error: {resp2}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: diffHeapSnapshots error path responds within 5s.
#[test]
fn test_profiler_diff_heap_snapshots_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = std::time::Instant::now();
    let _ = client.request(
        "forge/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": "/nonexistent/baseline.dmp",
            "comparison_dump_path": "/nonexistent/comparison.dmp",
        }),
    );
    let elapsed = start.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "diffHeapSnapshots took {elapsed:?}, target <5s"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// Benchmark: getObjectGraph error path responds within 3s.
#[test]
fn test_profiler_get_object_graph_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = std::time::Instant::now();
    let _ = client.request(
        "forge/profiler/getObjectGraph",
        json!({
            "dump_path": "/nonexistent/dump.dmp",
            "root_address": "0x00007ff812345678",
        }),
    );
    let elapsed = start.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "getObjectGraph took {elapsed:?}, target <3s"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}
