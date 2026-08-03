//! E2E tests for clean, editor-friendly host logging — Implements [DIST-CLEAN-OUTPUT].
//!
//! Editors (e.g. VS Code) capture the server's stderr into a user-facing Output
//! panel. The captured stream is a plain pipe, not a TTY, so any ANSI color
//! escape sequences leak through verbatim and render as garbage. The host must
//! therefore emit plain (un-colored) text whenever stderr is not a terminal.

use super::*;

/// The host's stderr must not contain ANSI escape (ESC, `0x1b`) codes when
/// stderr is captured as a pipe. Regression guard for issue #78: the stderr
/// `tracing` layer was hard-coded to `.with_ansi(true)`, flooding the editor's
/// Output panel with `\x1b[2m … \x1b[0m` garbage.
#[test]
fn test_server_stderr_has_no_ansi_escape_codes() {
    let mut client = LspClient::start_capture_stderr();
    let _ = client.initialize();
    client.shutdown_and_exit();
    client.wait_with_timeout();

    let stderr = client.read_stderr_to_string();

    // The startup banner ("SharpLsp LSP starting") is logged at INFO, so a
    // non-TTY run still produces several stderr lines to inspect.
    assert!(
        !stderr.is_empty(),
        "expected the host to log startup output to stderr, got nothing"
    );
    assert!(
        !stderr.contains('\u{1b}'),
        "host stderr must not contain ANSI escape (ESC) codes when captured by \
         an editor Output panel, but it did:\n{stderr:?}"
    );
}
