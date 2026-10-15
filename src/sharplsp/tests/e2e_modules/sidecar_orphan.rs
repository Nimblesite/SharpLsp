//! A REAL sidecar whose host dies before it ever connects: `[SIDECAR-PROCESS-PARENT]`
//! (GitHub #163).
//!
//! Once connected, a sidecar notices its host's death as end-of-stream on the
//! IPC pipe. Before it connects there is no pipe, so it waited in accept
//! forever, holding its endpoint. The published sidecar binaries are launched
//! exactly as the host launches them, supervised by a stand-in host process
//! that dies without connecting.

use super::sidecar_shutdown::{exits_within, is_running};
use super::*;
use std::io::BufRead;
use std::process::Stdio;

/// A real process standing in for the host: it idles until killed.
fn stand_in_host() -> std::process::Child {
    let mut command = if cfg!(windows) {
        let mut ping = std::process::Command::new("ping");
        let _ = ping.args(["-n", "60", "127.0.0.1"]);
        ping
    } else {
        let mut sleep = std::process::Command::new("sleep");
        let _ = sleep.arg("60");
        sleep
    };
    command.stdout(Stdio::null()).spawn().unwrap()
}

/// A fresh endpoint for one test, in the platform's IPC shape.
fn orphan_endpoint(language: &str) -> String {
    let tag = format!("sharplsp-orphan-{language}-{}", std::process::id());
    if cfg!(windows) {
        format!(r"\\.\pipe\{tag}")
    } else {
        std::env::temp_dir()
            .join(format!("{tag}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// Launch the published sidecar `env_key` names, supervised by `host`, and
/// return it once it has printed READY — bound and waiting for a connection.
fn launch_supervised(env_key: &str, endpoint: &str, host: u32) -> std::process::Child {
    let exe = std::env::var(env_key)
        .unwrap_or_else(|_| panic!("{env_key} must name the published sidecar"));
    let mut sidecar = std::process::Command::new(exe)
        .args([endpoint, "--parent-pid", &host.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert_ready(&mut sidecar, env_key, endpoint);
    sidecar
}

/// The first line `sidecar` prints is READY, advertising `endpoint`.
fn assert_ready(sidecar: &mut std::process::Child, env_key: &str, endpoint: &str) {
    let mut ready = String::new();
    let _ = std::io::BufReader::new(sidecar.stdout.as_mut().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(
        ready.starts_with("READY:"),
        "{env_key} must reach READY under a live host, got {ready:?}"
    );
    assert!(
        ready.contains(endpoint),
        "READY must advertise the requested endpoint {endpoint}: {ready:?}"
    );
}

/// Kill the stand-in host before anything connects; the sidecar must exit
/// on its own, promptly and cleanly.
fn assert_orphan_exits(env_key: &str, language: &str) {
    require_dotnet();
    let mut host = stand_in_host();
    let endpoint = orphan_endpoint(language);
    let sidecar = launch_supervised(env_key, &endpoint, host.id());
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        is_running(sidecar.id()),
        "{language} sidecar waits for its connection while the host lives"
    );

    host.kill().unwrap();
    let _ = host.wait();

    assert_exits_cleanly(sidecar, language);
}

/// `sidecar` exits on its own, promptly and with success.
fn assert_exits_cleanly(mut sidecar: std::process::Child, language: &str) {
    let exited = exits_within(sidecar.id(), Duration::from_secs(10));
    if !exited {
        // Never leave the orphan behind a failing run.
        let _ = sidecar.kill();
    }
    assert!(
        exited,
        "{language} sidecar must exit when its host dies before connecting (GitHub #163)"
    );
    let status = sidecar.wait().unwrap();
    assert!(
        status.success(),
        "{language} sidecar stops cleanly on host death: {status}"
    );
}

#[test]
fn test_csharp_sidecar_exits_when_its_host_dies_before_connecting() {
    assert_orphan_exits("SHARPLSP_CSHARP_SIDECAR_PATH", "csharp");
}

#[test]
fn test_fsharp_sidecar_exits_when_its_host_dies_before_connecting() {
    assert_orphan_exits("SHARPLSP_FSHARP_SIDECAR_PATH", "fsharp");
}
