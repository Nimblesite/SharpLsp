//! Platform-appropriate child processes for profiler unit tests.
//!
//! Profiler unit tests must pass on a plain Windows machine where Git Bash
//! coreutils (`true`, `sleep`) are NOT on PATH — `cmd.exe` builtins are the
//! only universally available equivalents there. Unix keeps the coreutils.
//! Compiled only under `cfg(test)`.

#![expect(
    clippy::expect_used,
    reason = "test support — panics are the correct failure mode"
)]

use std::process::{Child, Command, Stdio};

/// A spawnable command line: program plus arguments.
type Spec = (&'static str, &'static [&'static str]);

/// Command line for a child that exits immediately with success.
#[cfg(windows)]
const QUICK_SUCCESS: Spec = ("cmd", &["/C", "exit 0"]);

/// Command line for a child that exits immediately with success.
#[cfg(not(windows))]
const QUICK_SUCCESS: Spec = ("true", &[]);

/// Command line for a child that stays alive for ~60s (kill/cleanup tests).
/// `ping -n 60` fires one echo per second — the closest `cmd` builtin
/// equivalent of `sleep 60`; its output is discarded by [`spawn`].
#[cfg(windows)]
const LONG_LIVED: Spec = ("cmd", &["/C", "ping -n 60 127.0.0.1"]);

/// Command line for a child that stays alive for ~60s (kill/cleanup tests).
#[cfg(not(windows))]
const LONG_LIVED: Spec = ("sleep", &["60"]);

/// Command line for a child that blocks reading stdin and exits successfully
/// once it receives a newline — the same stop contract as `dotnet-trace`.
/// `pause` resumes on any redirected-stdin input and exits 0.
#[cfg(windows)]
const STDIN_WAITER: Spec = ("cmd", &["/C", "pause"]);

/// Command line for a child that blocks reading stdin and exits successfully
/// once it receives a newline — the same stop contract as `dotnet-trace`.
/// SIGINT is ignored (as dotnet-trace handles it gracefully) so tests can
/// assert the graceful path deterministically.
#[cfg(not(windows))]
const STDIN_WAITER: Spec = ("sh", &["-c", "trap '' INT; read _line"]);

/// Command line for a child that floods stdout with far more data than any
/// OS pipe buffer holds (10 000 × 33 bytes ≈ 330 KiB), then exits.
#[cfg(windows)]
const NOISY: Spec = (
    "cmd",
    &[
        "/C",
        "for /L %i in (1,1,10000) do @echo 0123456789abcdef0123456789abcdef",
    ],
);

/// Command line for a child that floods stdout with far more data than any
/// OS pipe buffer holds (10 000 × 33 bytes ≈ 330 KiB), then exits.
#[cfg(not(windows))]
const NOISY: Spec = (
    "sh",
    &[
        "-c",
        "i=0; while [ \"$i\" -lt 10000 ]; do echo 0123456789abcdef0123456789abcdef; i=$((i+1)); done",
    ],
);

/// Spawn a trivial child that exits immediately with success.
pub(crate) fn spawn_quick_success() -> Child {
    spawn(QUICK_SUCCESS, Stdio::null())
}

/// Spawn a long-lived (~60s) child, suitable for kill/cleanup tests.
pub(crate) fn spawn_long_lived() -> Child {
    spawn(LONG_LIVED, Stdio::null())
}

/// Spawn a child that blocks reading stdin and exits successfully once it
/// receives a newline. Its stdin is piped so tests can trigger the exit.
pub(crate) fn spawn_stdin_waiter() -> Child {
    spawn(STDIN_WAITER, Stdio::piped())
}

/// Spawn a child that floods stdout with more data than an OS pipe buffer
/// holds, then exits successfully. stdout/stderr are piped and initially
/// unread — exactly the stall scenario pipe draining must prevent.
pub(crate) fn spawn_noisy() -> Child {
    let (program, args) = NOISY;
    Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn noisy test child")
}

/// Spawn `spec` with the given stdin, discarding stdout/stderr.
fn spawn(spec: Spec, stdin: Stdio) -> Child {
    let (program, args) = spec;
    Command::new(program)
        .args(args)
        .stdin(stdin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn test child process")
}
