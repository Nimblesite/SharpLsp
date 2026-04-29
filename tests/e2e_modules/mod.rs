//! End-to-end test harness, shared fixtures, and helper functions.
//!
//! All sub-modules `use super::*;` to access everything defined here.

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
#![allow(dead_code, reason = "test helper methods may be used by future tests")]
#![expect(
    clippy::indexing_slicing,
    reason = "test code — JSON indexing panics are acceptable test failures"
)]
#![expect(
    clippy::needless_pass_by_value,
    reason = "test helper ergonomics — Value args are consumed"
)]
#![allow(
    clippy::too_many_lines,
    reason = "full-stack e2e tests are inherently long"
)]

// ── Infrastructure sub-modules ────────────────────────────────────
pub mod fixtures;
pub mod nav_helpers;

// ── Test sub-modules ──────────────────────────────────────────────
pub mod call_hierarchy_tests;
pub mod code_actions_tests;
pub mod coverage_boost;
pub mod coverage_boost2;
pub mod definition;
pub mod definition_full_stack;
pub mod definition_no_sidecar;
pub mod diagnostics;
pub mod diagnostics_full_stack;
pub mod document_sync;
pub mod folding;
pub mod fsharp;
pub mod full_stack;
pub mod full_stack_features;
pub mod full_stack_hierarchy;
pub mod full_stack_semantic;
pub mod hover;
pub mod inlay_hints_tests;
pub mod lifecycle;
pub mod lsp_features;
pub mod profiler;
pub mod profiler_edge_cases;
pub mod profiler_full_stack;
pub mod pull_diagnostics;
pub mod references;
pub mod selection;
pub mod semantic_coverage;
pub mod semantic_tokens_tests;
pub mod sort_members;
pub mod sort_members_extra;
pub mod standalone_csproj;
pub mod symbols;
pub mod type_hierarchy_tests;
pub mod version;
pub mod workspace_symbols;

// ── Re-exports so `use super::*;` in test modules gets everything ─
pub use fixtures::*;
pub use nav_helpers::*;

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use wait_timeout::ChildExt;

// ── Test Harness ──────────────────────────────────────────────────

/// Atomic counter for generating unique request IDs across tests.
pub static REQUEST_ID: AtomicI32 = AtomicI32::new(1);

pub fn next_id() -> i32 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

/// A running LSP server process with helpers for the JSON-RPC protocol.
pub struct LspClient {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    pub reader: BufReader<ChildStdout>,
}

impl LspClient {
    /// Spawn the sharplsp binary (stderr suppressed for fast tests).
    pub fn start() -> Self {
        Self::spawn(Stdio::null())
    }

    /// Spawn with stderr visible (for full-stack tests that need sidecar logs).
    pub fn start_verbose() -> Self {
        Self::spawn(Stdio::inherit())
    }

    pub fn spawn(stderr: Stdio) -> Self {
        let binary = sharplsp_binary_path();
        let debug = launcher_debug(&binary);
        let failure = format!("failed to spawn sharplsp\n{debug}");
        eprintln!("{debug}");
        let mut child = Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr)
            .spawn()
            .expect(&failure);
        let stdin = child.stdin.take().expect("no stdin");
        let stdout = child.stdout.take().expect("no stdout");
        let reader = BufReader::new(stdout);
        Self {
            child,
            stdin: Some(stdin),
            reader,
        }
    }

    /// Send a JSON-RPC message with proper Content-Length framing.
    pub fn send(&mut self, msg: &Value) {
        let body = serde_json::to_string(msg).unwrap();
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let stdin = self.stdin.as_mut().expect("stdin closed");
        stdin.write_all(header.as_bytes()).unwrap();
        stdin.write_all(body.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    /// Read one JSON-RPC message from stdout.
    pub fn recv(&mut self) -> Value {
        // Read headers until blank line.
        let mut content_length: usize = 0;
        loop {
            let mut line = String::new();
            let _ = self.reader.read_line(&mut line).unwrap();
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

    /// Send a request and return the response, skipping any
    /// server-initiated notifications (e.g. `publishDiagnostics`).
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
            // Notifications have no "id" field — skip them.
            if msg.get("id").is_some() {
                return msg;
            }
        }
    }

    /// Send a notification (no response expected).
    pub fn notify(&mut self, method: &str, params: Value) {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    /// Perform the LSP initialize handshake (no workspace root).
    pub fn initialize(&mut self) -> Value {
        self.initialize_with_root(Value::Null)
    }

    /// Perform the LSP initialize handshake with a workspace root URI.
    pub fn initialize_with_root(&mut self, root_uri: Value) -> Value {
        let resp = self.request(
            "initialize",
            json!({
                "processId": null,
                "capabilities": {},
                "rootUri": root_uri,
            }),
        );
        // Send initialized notification.
        self.notify("initialized", json!({}));
        resp
    }

    /// Send shutdown request + exit notification.
    pub fn shutdown_and_exit(&mut self) {
        let resp = self.request("shutdown", json!(null));
        assert!(resp.get("error").is_none(), "shutdown failed: {resp}");
        self.notify("exit", json!(null));
    }

    /// Open a C# document.
    pub fn open_document(&mut self, uri: &str, text: &str) {
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": "csharp",
                    "version": 1,
                    "text": text,
                }
            }),
        );
    }

    /// Change a document (full sync).
    pub fn change_document(&mut self, uri: &str, version: i32, text: &str) {
        self.notify(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "text": text }],
            }),
        );
    }

    /// Save a document.
    pub fn save_document(&mut self, uri: &str) {
        self.notify(
            "textDocument/didSave",
            json!({
                "textDocument": { "uri": uri },
            }),
        );
    }

    /// Close a document.
    pub fn close_document(&mut self, uri: &str) {
        self.notify(
            "textDocument/didClose",
            json!({
                "textDocument": { "uri": uri },
            }),
        );
    }

    /// Send a request, collecting all notifications received before the response.
    pub fn request_collecting_notifications(
        &mut self,
        method: &str,
        params: Value,
    ) -> (Value, Vec<Value>) {
        let id = next_id();
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        let mut notifications = Vec::new();
        loop {
            let msg = self.recv();
            if msg.get("id").is_some() {
                return (msg, notifications);
            }
            notifications.push(msg);
        }
    }

    /// Wait for a notification with the given method (with timeout).
    /// Returns the notification, or panics on timeout.
    pub fn wait_for_notification(&mut self, method: &str, timeout: Duration) -> Value {
        let deadline = Instant::now() + timeout;
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for notification: {method}"
            );
            let msg = self.recv();
            if msg.get("id").is_some() {
                continue; // skip responses
            }
            if msg.get("method").and_then(|m| m.as_str()) == Some(method) {
                return msg;
            }
        }
    }

    /// Wait for the process to exit (with timeout).
    pub fn wait_with_timeout(&mut self) {
        // Close stdin so the server's IO reader thread gets EOF and can finish.
        let _ = self.stdin.take();
        let result = self
            .child
            .wait_timeout(Duration::from_secs(5))
            .expect("wait failed");
        assert!(result.is_some(), "server did not exit within 5 seconds");
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn sharplsp_binary_path() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY.get_or_init(resolve_sharplsp_binary_path).clone()
}

fn resolve_sharplsp_binary_path() -> PathBuf {
    std::env::var_os("SHARPLSP_EXECUTABLE_PATH")
        .map(PathBuf::from)
        .map_or_else(
            || absolute_binary_path(env!("CARGO_BIN_EXE_sharplsp")),
            absolutize_binary_path,
        )
}

fn absolute_binary_path(path: &str) -> PathBuf {
    absolutize_binary_path(PathBuf::from(path))
}

fn absolutize_binary_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    let manifest_relative = Path::new(env!("CARGO_MANIFEST_DIR")).join(&path);
    if manifest_relative.exists() {
        return manifest_relative;
    }
    std::env::current_dir()
        .expect("read current dir")
        .join(path)
}

fn launcher_debug(binary: &Path) -> String {
    let cwd = std::env::current_dir().map_or_else(
        |err| format!("unavailable ({err})"),
        |path| path.display().to_string(),
    );
    let raw = std::env::var("SHARPLSP_EXECUTABLE_PATH")
        .unwrap_or_else(|_| env!("CARGO_BIN_EXE_sharplsp").to_string());
    let metadata = launcher_metadata(binary);
    format!(
        "sharplsp launcher: raw={raw} resolved={} cwd={cwd} exists={} {metadata}",
        binary.display(),
        binary.exists(),
    )
}

fn launcher_metadata(binary: &Path) -> String {
    std::fs::metadata(binary).map_or_else(
        |err| format!("metadata_error={err}"),
        |meta| format!("is_file={} len={}", meta.is_file(), meta.len()),
    )
}

/// Panic if `dotnet` CLI is not available. Tests MUST NOT silently skip.
pub fn require_dotnet() {
    assert!(
        std::process::Command::new("dotnet")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success()),
        "dotnet SDK is required — install it before running tests",
    );
}
