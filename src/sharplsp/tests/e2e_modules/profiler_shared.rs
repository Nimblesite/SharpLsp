//! Tests for [PROFILER-SHARED-LIBRARY-HOST]. See docs/specs/PROFILER-SPEC.md#PROFILER-SHARED-LIBRARY-HOST
//!
//! Full stack over the real LSP wire: `SharpLsp` mounts `lsp-profiler` with the
//! .NET runtime, the engine attaches to the real `ProfileTarget`, and every
//! operation is a standard `workspace/executeCommand`. Replaces the
//! `sharplsp/profiler/*` custom-request suites: process listing, kill guard,
//! CPU lifecycle with a real hotspot, heap snapshot → diff → references → gc,
//! unknown sessions, invalid PIDs and cancellation keep their assertions here.

use super::*;

/// Where the engine lands so the server finds it beside its own binary
/// ([PROFILER-SHARED-LIBRARY-ENGINE]).
fn install_engine_beside_server() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    let () = INSTALLED.get_or_init(|| {
        let engine_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../target/profiler-engine/lsp-profiler-dotnet-engine{}",
            std::env::consts::EXE_SUFFIX
        ));
        assert!(
            engine_src.is_file(),
            "build the engine first (`make _build-dotnet`): {}",
            engine_src.display()
        );
        let server = std::path::PathBuf::from(env!("CARGO_BIN_EXE_sharplsp"));
        let dir = server.parent().expect("server directory");
        for entry in
            std::fs::read_dir(engine_src.parent().expect("engine dir")).expect("engine dir listing")
        {
            let entry = entry.expect("engine dir entry");
            if entry.file_type().is_ok_and(|t| t.is_file()) {
                let _ = std::fs::copy(entry.path(), dir.join(entry.file_name()));
            }
        }
    });
}

/// Build `tests/fixtures/ProfileTarget` once and return its binary.
fn build_profile_target() -> std::path::PathBuf {
    static BINARY: OnceLock<std::path::PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| {
            let project_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/ProfileTarget");
            let binary = project_dir.join("bin/Release/net10.0/ProfileTarget");
            if binary.exists() || binary.with_extension("exe").exists() {
                return binary;
            }
            let output = Command::new("dotnet")
                .args(["build", "-c", "Release", "--nologo", "-v", "q"])
                .current_dir(&project_dir)
                .output()
                .expect("run dotnet build");
            assert!(
                output.status.success(),
                "ProfileTarget build failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            binary
        })
        .clone()
}

/// A running `ProfileTarget`, killed on drop.
struct Target {
    child: Child,
    pid: u32,
}

impl Target {
    fn start() -> Self {
        let mut child = Command::new(build_profile_target())
            .env(
                "SHARPLSP_PROFILE_TARGET_PARENT_PID",
                std::process::id().to_string(),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ProfileTarget");
        let stdout = child.stdout.take().expect("target stdout");
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line).expect("READY");
        assert_eq!(line.trim(), "READY");
        let pid = child.id();
        // Give the runtime a moment to open its diagnostics endpoint.
        std::thread::sleep(Duration::from_millis(800));
        Self { child, pid }
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn command(client: &mut LspClient, name: &str, params: Value) -> Value {
    client.request(
        "workspace/executeCommand",
        json!({ "command": format!("sharplsp.lspProfiler.{name}"), "arguments": [params] }),
    )
}

fn result(response: &Value, label: &str) -> Value {
    assert!(
        response.get("error").is_none(),
        "{label} failed: {response}"
    );
    response["result"].clone()
}

fn error_code(response: &Value, label: &str) -> i64 {
    response["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("{label} must fail: {response}"))
}

fn start_server() -> LspClient {
    install_engine_beside_server();
    require_dotnet();
    let mut client = LspClient::start_without_sidecars();
    let init = client.initialize();
    let commands = init["result"]["capabilities"]["executeCommandProvider"]["commands"].clone();
    assert!(
        commands
            .as_array()
            .is_some_and(|c| c.iter().any(|c| c == "sharplsp.lspProfiler.cpu.start")),
        "the server must advertise the profiler commands: {commands}"
    );
    let runtimes = &init["result"]["capabilities"]["experimental"]["lspProfiler"]["runtimes"];
    assert_eq!(runtimes[0]["id"], "dotnet", "{runtimes}");
    assert_eq!(
        runtimes[0]["memory"]["mode"]["kind"], "Direct",
        "{runtimes}"
    );
    client
}

#[test]
fn processes_lists_the_dotnet_target_and_refuses_to_kill_a_foreign_pid() {
    let target = Target::start();
    let mut client = start_server();
    let list = result(
        &command(&mut client, "processes", json!({ "workspace_roots": [] })),
        "processes",
    );
    let entry = list["processes"]
        .as_array()
        .expect("processes")
        .iter()
        .find(|p| p["pid"] == target.pid)
        .cloned()
        .unwrap_or_else(|| panic!("ProfileTarget pid {} missing from {list}", target.pid));
    assert_eq!(entry["runtime"], "dotnet");
    assert_eq!(entry["attachable"], true, "{entry}");
    assert!(
        entry["entry"]
            .as_str()
            .is_some_and(|e| e.contains("ProfileTarget")),
        "{entry}"
    );
    assert!(
        entry["runtime_version"]
            .as_str()
            .is_some_and(|v| !v.is_empty()),
        "{entry}"
    );

    let foreign = command(&mut client, "kill", json!({ "pid": std::process::id() }));
    assert_eq!(
        error_code(&foreign, "kill on the test host"),
        -32002,
        "the test host itself is not a .NET target, so kill refuses it: {foreign}"
    );
    let missing = command(&mut client, "kill", json!({ "pid": 999_999 }));
    assert_eq!(
        error_code(&missing, "kill on a dead pid"),
        -32001,
        "PROCESS_NOT_FOUND, not UNSUPPORTED_RUNTIME: {missing}"
    );
    client.shutdown_and_exit();
}

#[test]
fn cpu_profiling_the_target_reports_its_hot_functions_and_artifacts() {
    let target = Target::start();
    let mut client = start_server();
    let started = result(
        &command(&mut client, "cpu.start", json!({ "pid": target.pid })),
        "cpu.start",
    );
    let session_id = started["session_id"]
        .as_str()
        .expect("session_id")
        .to_owned();
    assert_eq!(started["runtime"], "dotnet");

    let again = command(&mut client, "cpu.start", json!({ "pid": target.pid }));
    assert_eq!(
        error_code(&again, "second start on the same pid"),
        -32004,
        "ALREADY_PROFILING: {again}"
    );

    std::thread::sleep(Duration::from_secs(3));
    let listed = result(&command(&mut client, "cpu.list", json!({})), "cpu.list");
    assert!(
        listed["sessions"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s["session_id"] == session_id)),
        "{listed}"
    );

    let report = result(
        &command(&mut client, "cpu.stop", json!({ "session_id": session_id })),
        "cpu.stop",
    );
    assert!(
        report["total_samples"].as_i64().unwrap_or(0) > 100,
        "{report}"
    );
    let names: Vec<String> = report["hot_functions"]
        .as_array()
        .expect("hot_functions")
        .iter()
        .filter_map(|f| f["name"].as_str().map(str::to_owned))
        .collect();
    assert!(
        names.iter().any(|n| n.contains("SlowJsonParsing")
            || n.contains("DeepCallStack")
            || n.contains("StringBuilderAllocation")),
        "ProfileTarget's workers must be hot: {names:?}"
    );
    for key in ["speedscope_path", "flamegraph_path", "cpuprofile_path"] {
        let path = report["artifacts"][key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} missing: {report}"));
        assert!(
            std::path::Path::new(path).is_file(),
            "{key} not written: {path}"
        );
    }

    let unknown = command(&mut client, "cpu.stop", json!({ "session_id": session_id }));
    assert_eq!(error_code(&unknown, "stopping twice"), -32000, "{unknown}");
    client.shutdown_and_exit();
}

#[test]
fn memory_profiling_the_target_snapshots_diffs_walks_references_and_collects() {
    let target = Target::start();
    let mut client = start_server();
    let started = result(
        &command(&mut client, "memory.start", json!({ "pid": target.pid })),
        "memory.start",
    );
    let session = json!({ "memory_session_id": started["memory_session_id"] });
    assert_eq!(started["mode"]["kind"], "Direct", "{started}");

    let snapshot = result(
        &command(&mut client, "memory.snapshot", session.clone()),
        "memory.snapshot",
    );
    let heap = &snapshot["result"]["outcome"]["snapshot"];
    assert!(heap["object_count"].as_i64().unwrap_or(0) > 0, "{snapshot}");
    let site = heap["sites"]
        .as_array()
        .expect("sites")
        .iter()
        .find(|s| s["type_name"] == "System.String")
        .cloned();
    assert!(site.is_some(), "strings are always live: {snapshot}");

    std::thread::sleep(Duration::from_secs(1));
    let diff = result(
        &command(&mut client, "memory.diff", session.clone()),
        "memory.diff",
    );
    assert!(
        diff["result"]["outcome"]["diff"]["grown"].is_array(),
        "{diff}"
    );

    let refs = result(
        &command(
            &mut client,
            "memory.references",
            json!({ "memory_session_id": started["memory_session_id"], "type_name": "System.String", "limit": 20, "max_depth": 4 }),
        ),
        "memory.references",
    );
    let graph = &refs["result"]["outcome"]["graph"];
    assert!(
        graph["nodes"]
            .as_array()
            .is_some_and(|n| n.iter().any(|n| n["is_target"] == true)),
        "{refs}"
    );

    let gc = result(
        &command(&mut client, "memory.gcCollect", session.clone()),
        "memory.gcCollect",
    );
    assert_eq!(gc["result"]["outcome"]["gc"]["collected"], 1, "{gc}");

    let stopped = result(&command(&mut client, "memory.stop", session), "memory.stop");
    assert_eq!(stopped["result"]["outcome"]["kind"], "Ack", "{stopped}");
    client.shutdown_and_exit();
}

#[test]
fn invalid_pids_and_foreign_commands_fail_with_protocol_codes() {
    let mut client = start_server();
    let missing = command(&mut client, "cpu.start", json!({ "pid": 999_999 }));
    assert_eq!(
        error_code(&missing, "cpu.start on a dead pid"),
        -32001,
        "PROCESS_NOT_FOUND: {missing}"
    );
    let not_dotnet = command(
        &mut client,
        "cpu.start",
        json!({ "pid": std::process::id() }),
    );
    assert_eq!(
        error_code(&not_dotnet, "cpu.start on the test host"),
        -32002,
        "UNSUPPORTED_RUNTIME: {not_dotnet}"
    );
    let bad = command(&mut client, "cpu.stop", json!({}));
    assert_eq!(
        error_code(&bad, "cpu.stop without a session"),
        -32602,
        "INVALID_PARAMS: {bad}"
    );
    let foreign = client.request(
        "workspace/executeCommand",
        json!({ "command": "sharplsp.somethingElse", "arguments": [] }),
    );
    assert!(
        foreign.get("error").is_some(),
        "a command outside the profiler is not silently accepted: {foreign}"
    );
    client.shutdown_and_exit();
}

/// A heap snapshot of a live target takes seconds, so a cancel sent right after
/// it is still in flight: the answer is `RequestCancelled`, the target keeps
/// running, and the same session snapshots normally afterwards ([PROFILER-SHARED-LIBRARY-HOST]).
#[test]
fn an_in_flight_profiler_request_can_be_cancelled() {
    let target = Target::start();
    let mut client = start_server();
    let started = result(
        &command(&mut client, "memory.start", json!({ "pid": target.pid })),
        "memory.start",
    );
    let session = json!({ "memory_session_id": started["memory_session_id"] });
    let id = next_id();
    client.send(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "workspace/executeCommand",
        "params": { "command": "sharplsp.lspProfiler.memory.snapshot", "arguments": [session] },
    }));
    client.notify("$/cancelRequest", json!({ "id": id }));
    let response = loop {
        let message = client.recv();
        if message["id"] == json!(id) && message.get("method").is_none() {
            break message;
        }
    };
    assert_eq!(
        response["error"]["code"].as_i64(),
        Some(-32800),
        "an in-flight snapshot is answered as cancelled: {response}"
    );
    let after = result(
        &command(&mut client, "memory.snapshot", session),
        "memory.snapshot after a cancel",
    );
    assert_eq!(after["result"]["outcome"]["kind"], "Snapshot", "{after}");
    drop(target);
    client.shutdown_and_exit();
}
