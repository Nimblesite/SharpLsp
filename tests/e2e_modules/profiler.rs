use super::*;

// ── Profiler Tests ────────────────────────────────────────────────

/// `sharplsp/profiler/listProcesses` returns a JSON array or tool-not-found error.
#[test]
fn test_profiler_list_processes() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("sharplsp/profiler/listProcesses", json!({}));

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

/// [PROFILER-PROCESS-LIST] `listProcesses` must return ONLY .NET processes,
/// never native OS daemons. Regression: it returned every row from `ps`/`wmic`
/// (PID 1 launchd/init, logd, systemstats, … ~972 entries on macOS).
#[test]
fn test_profiler_list_processes_filters_to_dotnet_only() {
    // Known native daemons from the bug report that must never appear.
    const NATIVE_DAEMONS: &[&str] = &[
        "launchd",
        "kernel_task",
        "logd",
        "smd",
        "systemstats",
        "mds",
        "systemd",
    ];

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("sharplsp/profiler/listProcesses", json!({}));

    let result = &resp["result"];
    assert!(result.is_array(), "result must be a JSON array: {resp}");
    if let Some(processes) = result.as_array() {
        // PID 1 (launchd on macOS, init/systemd on Linux) always exists, is
        // always returned by an unfiltered `ps -e`, and is NEVER .NET. Its
        // presence proves the list is unfiltered.
        let pid1_present = processes.iter().any(|p| p["pid"].as_u64() == Some(1));
        assert!(
            !pid1_present,
            "PID 1 (init/launchd) leaked into the .NET process list — not filtered"
        );

        // Known native daemons from the bug report must never appear.
        for proc in processes {
            let name = proc["name"].as_str().unwrap_or("");
            assert!(
                !NATIVE_DAEMONS.contains(&name),
                "native OS process '{name}' must be filtered out of the .NET list"
            );
        }
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// [PROFILER-PROCESS-LIST] `listProcesses` exposes a `runtime_version` on every
/// row and returns the list sorted by (case-insensitive name, pid).
#[test]
fn test_profiler_list_processes_sorted_with_runtime_version() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("sharplsp/profiler/listProcesses", json!({}));

    let result = &resp["result"];
    assert!(result.is_array(), "result must be a JSON array: {resp}");
    if let Some(processes) = result.as_array() {
        // Every process carries a `runtime_version` field (may be null).
        for proc in processes {
            assert!(
                proc.get("runtime_version").is_some(),
                "every process must expose a runtime_version field: {proc}"
            );
        }
        // The list is sorted by (lowercased name, pid).
        let keys: Vec<(String, u64)> = processes
            .iter()
            .map(|p| {
                (
                    p["name"].as_str().unwrap_or("").to_ascii_lowercase(),
                    p["pid"].as_u64().unwrap_or(0),
                )
            })
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "process list must be sorted by (name, pid)");
    }

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// [PROFILER-PROCESS-LIST] `killProcess` refuses a non-.NET PID. PID 1
/// (launchd/init) is never .NET, so the safety guard must reject it WITHOUT
/// sending any signal — the server must return an error and not crash.
#[test]
fn test_profiler_kill_process_refuses_non_dotnet_pid() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request("sharplsp/profiler/killProcess", json!({ "pid": 1 }));

    assert!(
        resp.get("error").is_some(),
        "killing PID 1 must be refused, got: {resp}"
    );
    let msg = resp["error"]["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("not a running .NET process") || msg.contains("refusing"),
        "error must explain the refusal, got: {msg}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// [PROFILER-PROCESS-LIST] `killProcess` errors on a non-existent PID without
/// crashing the server.
#[test]
fn test_profiler_kill_process_invalid_pid() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/killProcess",
        json!({ "pid": 999_999_999 }),
    );

    assert!(
        resp.get("error").is_some(),
        "killing a non-existent PID must return an error: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `sharplsp/profiler/startTrace` returns an error for a non-existent PID
/// (tool not found or attach failure — both acceptable, server must not crash).
#[test]
fn test_profiler_start_trace_invalid_pid() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({ "pid": 999_999_999 }),
    );

    // Either error or result is fine — just must not crash.
    assert!(
        resp.get("error").is_some() || resp.get("result").is_some(),
        "must return a response: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `sharplsp/profiler/stopTrace` errors for a non-existent session.
#[test]
fn test_profiler_stop_trace_unknown_session() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/stopTrace",
        json!({ "session_id": "nonexistent-session-id" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for unknown session: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `sharplsp/profiler/stopCounters` errors for a non-existent session.
#[test]
fn test_profiler_stop_counters_unknown_session() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/stopCounters",
        json!({ "session_id": "nonexistent-session-id" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for unknown session: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `sharplsp/profiler/analyzeHeap` errors for a nonexistent dump file.
#[test]
fn test_profiler_analyze_heap_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/analyzeHeap",
        json!({ "dump_path": "/nonexistent/path/to/dump.dmp" }),
    );

    assert!(
        resp.get("error").is_some(),
        "must error for missing dump: {resp}"
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();
}

/// `sharplsp/profiler/findGCRoots` errors for a nonexistent dump file.
#[test]
fn test_profiler_find_gc_roots_missing_file() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/findGCRoots",
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

// ── convertTrace: real dotnet-trace invocation ───────────────────

/// `sharplsp/profiler/convertTrace` on a real `.nettrace` file must return a
/// path that actually exists on disk.
///
/// This test REPRODUCES and PROVES the fix for the bug where
/// `derived_output_path` appended `.speedscope.json` to the full `.nettrace`
/// filename instead of replacing the extension. Before the fix the server
/// returned `"<name>.nettrace.speedscope.json"` which `stat` could not find
/// because `dotnet-trace convert` actually writes `<name>.speedscope.json`.
///
/// The test is skipped when `dotnet-trace` is not on PATH or when no real
/// `.nettrace` sample is available to seed the conversion.
#[test]
fn test_profiler_convert_trace_real_file_roundtrip() {
    let Some(sample) = locate_nettrace_sample() else {
        eprintln!(
            "skip: no real .nettrace sample available; run a trace once to populate .sharplsp/profiles/"
        );
        return;
    };
    if !has_dotnet_trace() {
        eprintln!("skip: dotnet-trace not installed on PATH");
        return;
    }

    // Copy the sample into a unique tempdir so the test is isolated from any
    // previously-converted sibling file on disk. This guarantees the
    // `.speedscope.json` we assert on was created by THIS test invocation.
    let tmp = tempfile::tempdir().expect("tempdir");
    let input_path = tmp.path().join("roundtrip.nettrace");
    let _bytes = std::fs::copy(&sample, &input_path).expect("copy .nettrace into tempdir");

    let mut client = LspClient::start();
    let _ = client.initialize();

    let resp = client.request(
        "sharplsp/profiler/convertTrace",
        json!({
            "input_path": input_path.to_str().unwrap(),
            "format": "speedscope",
        }),
    );

    client.shutdown_and_exit();
    client.wait_with_timeout();

    // Must succeed — this is the actual fix assertion.
    assert!(
        resp.get("error").is_none(),
        "convertTrace must succeed on a real .nettrace, got error: {}",
        resp.get("error")
            .map(std::string::ToString::to_string)
            .unwrap_or_default(),
    );

    let result = &resp["result"];
    let output_path = result["output_path"]
        .as_str()
        .expect("result.output_path must be a string");

    // The returned path must exist on disk — this is what failed before the
    // fix (server returned `<x>.nettrace.speedscope.json` but dotnet-trace
    // wrote `<x>.speedscope.json`).
    assert!(
        std::path::Path::new(output_path).exists(),
        "output_path must exist on disk — returned {output_path} but file is missing",
    );

    // Stronger assertion: the path must be the stripped form, not the
    // doubled form. Catches any regression that silently creates a file
    // matching the wrong name.
    assert!(
        output_path.ends_with("roundtrip.speedscope.json"),
        "output_path must end with .speedscope.json (stripped form), got {output_path}",
    );
    assert!(
        !output_path.contains(".nettrace.speedscope.json"),
        "BUG REGRESSION: path uses the doubled form .nettrace.speedscope.json — got {output_path}",
    );

    // file_size_bytes must be populated and match actual file length.
    let reported = result["file_size_bytes"]
        .as_u64()
        .expect("file_size_bytes must be a u64");
    let actual = std::fs::metadata(output_path)
        .expect("stat converted file")
        .len();
    assert_eq!(
        reported, actual,
        "reported file_size_bytes {reported} must match actual {actual}",
    );
}

/// Negative assertion: the doubled-suffix path MUST NOT be written by
/// `dotnet-trace convert`. If this ever starts existing we need to
/// re-examine the tool's naming convention.
#[test]
fn test_profiler_convert_trace_does_not_write_doubled_suffix() {
    let Some(sample) = locate_nettrace_sample() else {
        eprintln!("skip: no real .nettrace sample available");
        return;
    };
    if !has_dotnet_trace() {
        eprintln!("skip: dotnet-trace not installed on PATH");
        return;
    }

    let tmp = tempfile::tempdir().expect("tempdir");
    let input_path = tmp.path().join("no-double.nettrace");
    let _bytes = std::fs::copy(&sample, &input_path).expect("copy .nettrace into tempdir");

    let mut client = LspClient::start();
    let _ = client.initialize();
    let resp = client.request(
        "sharplsp/profiler/convertTrace",
        json!({ "input_path": input_path.to_str().unwrap() }),
    );
    client.shutdown_and_exit();
    client.wait_with_timeout();

    assert!(resp.get("error").is_none(), "convert must succeed: {resp}");

    let doubled = tmp.path().join("no-double.nettrace.speedscope.json");
    assert!(
        !doubled.exists(),
        "dotnet-trace must not have written the doubled-suffix file at {}",
        doubled.display(),
    );
    let stripped = tmp.path().join("no-double.speedscope.json");
    assert!(
        stripped.exists(),
        "dotnet-trace must have written the stripped-suffix file at {}",
        stripped.display(),
    );
}

/// Locate a real `.nettrace` sample to seed the convertTrace test, or
/// return None so the test skips gracefully on environments without one.
///
/// Looks in `.sharplsp/profiles/` (relative to the workspace root) for any
/// previously captured trace. This keeps the test self-contained without
/// committing a binary fixture to the repo.
fn has_dotnet_trace() -> bool {
    std::process::Command::new("dotnet-trace")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn locate_nettrace_sample() -> Option<std::path::PathBuf> {
    let profiles_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".sharplsp/profiles");
    let entries = std::fs::read_dir(profiles_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("nettrace") {
            return Some(path);
        }
    }
    None
}

// ── Profiler Performance Benchmarks ──────────────────────────────

/// Benchmark: `sharplsp/profiler/listProcesses` completes within 500ms.
#[test]
fn test_profiler_list_processes_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request("sharplsp/profiler/listProcesses", json!({}));
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

/// Benchmark: `sharplsp/profiler/startTrace` responds within 1s (even for invalid PID).
#[test]
fn test_profiler_start_trace_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "sharplsp/profiler/startTrace",
        json!({ "pid": 999_999_999 }),
    );
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
        "sharplsp/profiler/stopCounters",
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

/// Benchmark: `sharplsp/profiler/analyzeHeap` error path responds within 5s.
#[test]
fn test_profiler_analyze_heap_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "sharplsp/profiler/analyzeHeap",
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

/// Benchmark: `sharplsp/profiler/findGCRoots` error path responds within 10s.
#[test]
fn test_profiler_find_gc_roots_latency() {
    let mut client = LspClient::start();
    let _ = client.initialize();

    let start = Instant::now();
    let resp = client.request(
        "sharplsp/profiler/findGCRoots",
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
        "sharplsp/profiler/inspectObject",
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
        "sharplsp/profiler/diffHeapSnapshots",
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
        "sharplsp/profiler/diffHeapSnapshots",
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
        "sharplsp/profiler/getObjectGraph",
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
        "sharplsp/profiler/diffHeapSnapshots",
        json!({
            "baseline_dump_path": "/no/such/file.dmp",
            "comparison_dump_path": "/no/such/file2.dmp",
        }),
    );

    // Server must still handle an in-process request that does not depend on
    // optional diagnostic tools being installed.
    let resp2 = client.request("workspace/symbol", json!({ "query": "" }));
    assert_eq!(resp2["jsonrpc"], "2.0", "must be JSON-RPC 2.0");
    assert!(
        resp2.get("error").is_none(),
        "server must still respond after diffHeapSnapshots error: {resp2}"
    );
    assert!(
        resp2["result"].is_null() || resp2["result"].as_array().is_some(),
        "workspace/symbol must return null or array: {resp2}"
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
        "sharplsp/profiler/diffHeapSnapshots",
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
        "sharplsp/profiler/getObjectGraph",
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
