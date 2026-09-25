//! Graceful shutdown of the REAL sidecars: `[SIDECAR-SHUTDOWN-ACK]` and
//! `[SIDECAR-SHUTDOWN-PROTOCOL]` (GitHub #172).
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
