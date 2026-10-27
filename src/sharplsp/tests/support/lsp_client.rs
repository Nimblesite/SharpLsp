//! Shared stdio JSON-RPC test client for host-level e2e suites.
//!
//! Extracted from `tests/nuget_e2e.rs` (unchanged behaviour) so
//! `tests/project_edit_e2e.rs` can drive the same real `sharplsp` binary
//! without a third copy of the harness.

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::needless_pass_by_value,
    reason = "test helper ergonomics — Value args feed json! macros"
)]
#![expect(
    unused_results,
    reason = "test code — initialize() and I/O return values are intentionally discarded"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};

use serde_json::{json, Value};

#[path = "built_binary.rs"]
mod built_binary;

// ── Test Harness ──────────────────────────────────────────────────

/// Build a valid RFC 8089 `file://` URI cross-platform. On Windows a bare
/// `file://` + `display()` yields `file://\\?\C:\dir` (backslashes, verbatim
/// prefix), which the host rejects; this normalizes to `file:///C:/dir`. [#110]
pub fn path_to_file_uri(path: &Path) -> String {
    let text = path.display().to_string();
    if cfg!(windows) {
        let normalized = text
            .strip_prefix(r"\\?\")
            .unwrap_or(&text)
            .replace('\\', "/");
        format!("file:///{normalized}")
    } else {
        format!("file://{text}")
    }
}

static REQUEST_ID: AtomicI32 = AtomicI32::new(1000);

fn next_id() -> i32 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

/// How [`LspClient::start_with`] starts the server.
pub struct Start<'a> {
    /// The server's working directory, where a `sharplsp.toml` is picked up.
    pub cwd: Option<&'a Path>,
    /// A directory searched before the inherited `PATH`.
    pub path_first: Option<&'a Path>,
}

pub struct LspClient {
    child: Child,
    stdin: Option<ChildStdin>,
    reader: BufReader<ChildStdout>,
}

impl LspClient {
    pub fn start() -> Self {
        Self::start_in(None)
    }

    /// Start the server with `dir` as its working directory, so a `sharplsp.toml`
    /// placed there is picked up. Since [SCRIPT-ROUTE-LAZY] the sidecar managers are
    /// always constructed — a single file with no project starts one lazily — so
    /// config is the only way to get a server that genuinely has no sidecars.
    pub fn start_in(dir: Option<&Path>) -> Self {
        Self::start_with(Start {
            cwd: dir,
            path_first: None,
        })
    }

    /// Start the server as `start` says: in its working directory, and with its
    /// directory searched first for executables, so a test can put a stand-in
    /// `dotnet` in front of the real one.
    pub fn start_with(start: Start<'_>) -> Self {
        let mut command = Command::new(built_binary::built_sharplsp());
        if let Some(cwd) = start.cwd {
            command.current_dir(cwd);
        }
        if let Some(first) = start.path_first {
            let inherited = std::env::var_os("PATH").unwrap_or_default();
            let search =
                std::iter::once(first.to_path_buf()).chain(std::env::split_paths(&inherited));
            command.env("PATH", std::env::join_paths(search).expect("join PATH"));
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn sharplsp");
        let stdin = child.stdin.take().expect("no stdin");
        let stdout = child.stdout.take().expect("no stdout");
        Self {
            child,
            stdin: Some(stdin),
            reader: BufReader::new(stdout),
        }
    }

    fn send(&mut self, msg: &Value) {
        let body = serde_json::to_string(msg).unwrap();
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let stdin = self.stdin.as_mut().expect("stdin closed");
        stdin.write_all(header.as_bytes()).unwrap();
        stdin.write_all(body.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Value {
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            self.reader.read_line(&mut line).unwrap();
            let trimmed = line.trim().to_string();
            if trimmed.is_empty() {
                break;
            }
            if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                content_length = len_str.parse().unwrap();
            }
        }
        assert!(content_length > 0, "no Content-Length header");
        let mut body = vec![0u8; content_length];
        self.reader.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    pub fn request(&mut self, method: &str, params: Value) -> Value {
        let id = next_id();
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        loop {
            let msg = self.recv();
            if msg.get("id").is_some() {
                return msg;
            }
        }
    }

    pub fn notify(&mut self, method: &str, params: Value) {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    pub fn initialize(&mut self) -> Value {
        let resp = self.request(
            "initialize",
            json!({
                "processId": null,
                "capabilities": {},
                "rootUri": null,
            }),
        );
        self.notify("initialized", json!({}));
        resp
    }

    /// Initialize with a workspace root so the C# sidecar (which owns `MSBuild`
    /// package editing, [NUGET-XML-DOM]) is created. Required by install /
    /// uninstall / consolidate, which delegate the XML mutation to the sidecar.
    pub fn initialize_with_root(&mut self, dir: &Path) -> Value {
        let resp = self.request(
            "initialize",
            json!({
                "processId": null,
                "capabilities": {},
                "rootUri": path_to_file_uri(dir),
            }),
        );
        self.notify("initialized", json!({}));
        resp
    }

    pub fn shutdown_and_exit(&mut self) {
        let resp = self.request("shutdown", json!(null));
        assert!(resp.get("error").is_none(), "shutdown failed: {resp}");
        self.notify("exit", json!(null));
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
    }
}

/// Whether a usable `dotnet` CLI is on PATH. Edits delegated to the C# sidecar
/// (`MSBuild` document model) need the .NET SDK; when it is absent, tests that
/// require it no-op instead of failing spuriously.
pub fn require_dotnet() -> bool {
    let ok = std::process::Command::new("dotnet")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success());
    if !ok {
        eprintln!("skipping: dotnet CLI not available for sidecar-backed project edit");
    }
    ok
}
