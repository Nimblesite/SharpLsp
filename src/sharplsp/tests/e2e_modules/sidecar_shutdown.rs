//! Graceful shutdown and hard host death of the REAL sidecars: `[SIDECAR-SHUTDOWN-ACK]`,
//! `[SIDECAR-SHUTDOWN-PROTOCOL]` (GitHub #172), `[SIDECAR-PROCESS-PARENT]` (GitHub #163).
//!
//! The sidecar cancelled the token its own acknowledgement was written with, so
//! the host never received one and every shutdown ended in a hard kill. The host
//! logs how each shutdown ENDED, and that log is the evidence read here.

use super::*;
use std::process::Stdio;

/// Start the host with its stderr in a file. A pipe nobody drains fills while
/// the sidecar loads and stalls the host, and a build node the sidecar started
/// can hold a pipe open long after the host has gone.
fn start_logging_to(log: &tempfile::NamedTempFile) -> LspClient {
    LspClient::spawn(Stdio::from(log.reopen().unwrap()))
}

/// Shut the host down the way an editor does, then read what it logged.
fn shut_down(mut client: LspClient, log: &tempfile::NamedTempFile) -> String {
    client.shutdown_and_exit();
    client.wait_with_timeout();
    std::fs::read_to_string(log.path()).unwrap()
}

/// `sidecar` acknowledged, exited on its own with success, and was never killed.
fn assert_graceful(log: &str, sidecar: &str) {
    let mine: Vec<&str> = log.lines().filter(|line| line.contains(sidecar)).collect();
    let exit = mine
        .iter()
        .find(|line| line.contains("acknowledged shutdown and exited on its own"));
    assert!(
        exit.is_some(),
        "{sidecar} must acknowledge shutdown and exit on its own; its log:\n{}",
        mine.join("\n")
    );
    assert!(
        exit.is_some_and(|line| line.contains("success=true")),
        "{sidecar} must exit zero: {exit:?}"
    );
    assert!(
        !mine.iter().any(|line| line.contains("Killing sidecar")
            || line.contains("did not acknowledge shutdown")),
        "{sidecar} must never be killed; its log:\n{}",
        mine.join("\n")
    );
}

/// The PID the host logged when it spawned `sidecar`.
fn spawned_pid(log: &str, sidecar: &str) -> u32 {
    log.lines()
        .filter(|line| line.contains("Sidecar process spawned") && line.contains(sidecar))
        .find_map(|line| {
            line.split_whitespace()
                .find_map(|field| field.strip_prefix("pid="))
        })
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("the host must log {sidecar}'s spawned PID; log:\n{log}"))
}

/// Whether `pid` names a live process, asked of the OS by that exact PID.
pub(super) fn is_running(pid: u32) -> bool {
    let probe = if cfg!(windows) {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")))
    } else {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|out| out.status.success())
    };
    probe.unwrap()
}

/// Whether `pid` is gone within `bound`.
fn exits_within(pid: u32, bound: Duration) -> bool {
    let deadline = std::time::Instant::now() + bound;
    while std::time::Instant::now() < deadline {
        if !is_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Every live descendant of `root`, found by walking parent links in the OS
/// process table — never by executable name.
#[cfg(windows)]
fn descendants(root: u32) -> Vec<u32> {
    let links = parent_links();
    let mut tree = vec![root];
    let mut next = 0;
    while let Some(&current) = tree.get(next) {
        let children: Vec<u32> = links
            .iter()
            .filter(|(pid, parent)| *parent == current && !tree.contains(pid))
            .map(|(pid, _)| *pid)
            .collect();
        tree.extend(children);
        next += 1;
    }
    tree.retain(|pid| *pid != root);
    tree
}

/// Every live `(pid, parent pid)` pair in the OS process table.
#[cfg(windows)]
fn parent_links() -> Vec<(u32, u32)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let _ = system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    system
        .processes()
        .values()
        .filter_map(|process| Some((process.pid().as_u32(), process.parent()?.as_u32())))
        .collect()
}

/// Descendant containment is Windows-only so far (`[SIDECAR-PROCESS-TREE]`).
#[cfg(not(windows))]
fn descendants(_root: u32) -> Vec<u32> {
    Vec::new()
}

/// Kill the host the way a crash or Task Manager does — no shutdown, no
/// drops — and require that `sidecar` dies with it and, on Windows, every
/// process it started too; Unix descendants wait on the host-side process
/// group. `[SIDECAR-PROCESS-PARENT]`, `[SIDECAR-PROCESS-TREE]` (GitHub #163)
fn assert_dies_with_host(mut client: LspClient, log: &tempfile::NamedTempFile, sidecar: &str) {
    let pid = spawned_pid(&std::fs::read_to_string(log.path()).unwrap(), sidecar);
    assert!(
        is_running(pid),
        "{sidecar} (pid {pid}) is up before the host dies"
    );
    assert_ne!(pid, client.child.id(), "the sidecar is not the host");
    let tree = descendants(pid);

    client.child.kill().unwrap();
    let _ = client.child.wait();

    assert!(
        exits_within(pid, Duration::from_secs(10)),
        "{sidecar} (pid {pid}) must exit once its host is hard-killed (GitHub #163)"
    );
    assert_no_survivors(&tree, sidecar);
}

/// Every process in `tree` exits within the bound.
fn assert_no_survivors(tree: &[u32], sidecar: &str) {
    let survivors: Vec<u32> = tree
        .iter()
        .copied()
        .filter(|child| !exits_within(*child, Duration::from_secs(10)))
        .collect();
    assert!(
        survivors.is_empty(),
        "{sidecar}'s descendants {survivors:?} must die with it (GitHub #163)"
    );
}

#[test]
fn test_fsharp_sidecar_dies_with_a_hard_killed_host() {
    require_dotnet();
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = start_logging_to(&log);
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);
    let ready = poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));
    assert!(
        !ready.is_null(),
        "the F# sidecar answers before its host dies"
    );

    assert_dies_with_host(client, &log, "F# (FCS)");
}

#[test]
fn test_csharp_sidecar_dies_with_a_hard_killed_host() {
    require_dotnet();
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = start_logging_to(&log);
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);
    let ready = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));
    assert!(
        !ready.is_null(),
        "the C# sidecar answers before its host dies"
    );

    assert_dies_with_host(client, &log, "C# (Roslyn)");
}

#[test]
fn test_fsharp_sidecar_acknowledges_shutdown_and_exits_on_its_own() {
    require_dotnet();
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_tmp, root_uri, file_uri, source) = create_fsharp_test_workspace();
    let mut client = start_logging_to(&log);
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // `Calculator` on `module Calculator =`: the F# sidecar is up and answering.
    let ready = poll_hover_until_ready(&mut client, &file_uri, 3, 7, Duration::from_secs(90));
    assert!(
        ready["contents"]["value"]
            .as_str()
            .is_some_and(|markdown| markdown.contains("Calculator")),
        "the F# sidecar answers before it is stopped: {ready}"
    );

    assert_graceful(&shut_down(client, &log), "F# (FCS)");
}

#[test]
fn test_csharp_sidecar_acknowledges_shutdown_and_exits_on_its_own() {
    require_dotnet();
    let log = tempfile::NamedTempFile::new().unwrap();
    let (_tmp, root_uri, file_uri, source) = create_test_workspace();
    let mut client = start_logging_to(&log);
    let _ = client.initialize_with_root(json!(root_uri));
    client.open_document(&file_uri, &source);

    // `Calculator` on its class declaration: the C# sidecar is up and answering.
    let ready = poll_hover_until_ready(&mut client, &file_uri, 3, 14, Duration::from_secs(90));
    assert!(
        ready["contents"]["value"]
            .as_str()
            .is_some_and(|markdown| markdown.contains("Calculator")),
        "the C# sidecar answers before it is stopped: {ready}"
    );

    assert_graceful(&shut_down(client, &log), "C# (Roslyn)");
}
