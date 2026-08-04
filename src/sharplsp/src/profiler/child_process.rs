//! Lifecycle helpers for spawned diagnostic-tool child processes.
//!
//! The dotnet diagnostic CLIs (`dotnet-trace collect` in particular) must be
//! stopped *gracefully* so they can finalize their output artifacts: on
//! Windows, `Child::kill()` is `TerminateProcess`, which never gives
//! dotnet-trace the chance to write the trailing rundown — the resulting
//! `.nettrace` is corrupt and unconvertible. The tools' documented,
//! cross-platform stop trigger is a newline (Enter) on stdin. [GitHub #110]

use std::io::{Read, Write};
use std::process::{Child, ExitStatus};
use std::time::{Duration, Instant};

use tracing::warn;

/// Interval between `try_wait` polls while waiting for a child to exit.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Stop a child gracefully: write Enter to its stdin (and send SIGINT on
/// Unix), wait up to `timeout` for it to flush and exit, and only then fall
/// back to a hard kill. The child is reaped before returning.
pub(crate) fn stop_gracefully(child: &mut Child, timeout: Duration) {
    signal_graceful_exit(child);
    if wait_for_exit(child, timeout).is_none() {
        warn!(
            timeout_secs = timeout.as_secs(),
            "child ignored graceful stop; killing"
        );
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Ask the child to exit on its own: write Enter to its stdin — the dotnet
/// diagnostic tools' documented stop trigger on every platform — then close
/// stdin (EOF, a second independent exit signal). On Unix additionally send
/// SIGINT, which dotnet-trace also handles gracefully.
fn signal_graceful_exit(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
        // Dropping `stdin` here closes the pipe.
    }
    #[cfg(unix)]
    send_sigint(child.id());
}

/// Send SIGINT via `kill -INT` — the Ctrl-C equivalent dotnet-trace traps to
/// flush the trace file before exiting.
#[cfg(unix)]
fn send_sigint(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        let _ = std::process::Command::new("kill")
            .args(["-INT", &pid.to_string()])
            .status();
    }
}

/// Poll `try_wait` until the child exits or `timeout` elapses. Returns the
/// exit status if it exited in time, `None` on timeout or wait error.
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() >= deadline => return None,
            Ok(None) => std::thread::sleep(POLL_INTERVAL),
            Err(_) => return None,
        }
    }
}

/// Hand the child's piped stdout/stderr to background drain threads.
///
/// A long-running collector writes progress output; once the OS pipe buffer
/// fills with nobody reading, the child blocks on `write` and collection
/// stalls. Reading to EOF (rather than dropping the handles) avoids handing
/// the child a broken pipe.
pub(crate) fn drain_output(child: &mut Child) {
    if let Some(stdout) = child.stdout.take() {
        drain_to_sink("stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_to_sink("stderr", stderr);
    }
}

/// Read `stream` to EOF on a detached background thread, discarding the bytes.
fn drain_to_sink(label: &'static str, stream: impl Read + Send + 'static) {
    let builder = std::thread::Builder::new().name(format!("sharplsp-drain-{label}"));
    let spawned = builder.spawn(move || {
        let mut stream = stream;
        let _ = std::io::copy(&mut stream, &mut std::io::sink());
    });
    if let Err(err) = spawned {
        warn!(stream = label, "failed to spawn pipe-drain thread: {err}");
    }
}

#[cfg(test)]
#[expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;
    use crate::profiler::test_support;

    #[test]
    fn stop_gracefully_lets_stdin_waiter_exit_cleanly() {
        let mut child = test_support::spawn_stdin_waiter();
        // Give the child time to install its signal handling / start reading
        // stdin before any stop signal can race its startup.
        std::thread::sleep(Duration::from_millis(250));

        stop_gracefully(&mut child, Duration::from_secs(10));

        let status = child.wait().expect("stdin waiter exit status");
        assert!(
            status.success(),
            "child must exit via the graceful stdin-newline path, not be killed: {status}"
        );
    }

    #[test]
    fn stop_gracefully_kills_child_that_ignores_stop_signals() {
        let mut child = test_support::spawn_long_lived();

        stop_gracefully(&mut child, Duration::from_millis(200));

        let exited = child.try_wait().expect("query long-lived child");
        assert!(
            exited.is_some(),
            "child must be dead once stop_gracefully returns (kill fallback)"
        );
    }

    #[test]
    fn drain_output_prevents_pipe_buffer_stall() {
        use wait_timeout::ChildExt;

        let mut child = test_support::spawn_noisy();
        drain_output(&mut child);

        // Without draining, the child blocks forever once the OS pipe buffer
        // fills (~64 KiB) — it writes ~330 KiB. Drained, it must exit.
        let status = child
            .wait_timeout(Duration::from_secs(30))
            .expect("wait on noisy child")
            .expect("noisy child must exit once its output is drained");
        assert!(status.success(), "noisy child failed: {status}");
    }
}
