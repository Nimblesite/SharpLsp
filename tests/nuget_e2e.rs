//! End-to-end tests for `forge/nuget/*` LSP custom requests.
//!
//! Tests spawn the `forge-lsp` binary and communicate over stdio JSON-RPC,
//! exactly like a real LSP client.

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::expect_used,
    reason = "test code — panics are the correct failure mode"
)]
#![expect(
    clippy::indexing_slicing,
    reason = "test code — JSON indexing panics are acceptable test failures"
)]
#![expect(
    clippy::needless_pass_by_value,
    reason = "test helper ergonomics — Value args are consumed"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};

use serde_json::{json, Value};

// ── Test Harness ──────────────────────────────────────────────────

static REQUEST_ID: AtomicI32 = AtomicI32::new(1000);

fn next_id() -> i32 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

struct LspClient {
    child: Child,
    stdin: Option<ChildStdin>,
    reader: BufReader<ChildStdout>,
}

impl LspClient {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_forge-lsp"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn forge-lsp");
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

    fn request(&mut self, method: &str, params: Value) -> Value {
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

    fn notify(&mut self, method: &str, params: Value) {
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    fn initialize(&mut self) -> Value {
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

    fn shutdown_and_exit(&mut self) {
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

/// Absolute path to the `NuGetTest` test fixture project.
fn nuget_test_project() -> String {
    let manifest = env!("CARGO_MANIFEST_DIR");
    format!("{manifest}/tests/fixtures/NuGetTest/NuGetTest.csproj")
}

// ── forge/nuget/search ──────────────────────────────────────────

#[test]
fn nuget_search_returns_packages_for_known_query() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/search",
        json!({
            "query": "Newtonsoft.Json",
            "projectPath": nuget_test_project(),
            "prerelease": false,
            "take": 5,
            "skip": 0,
        }),
    );

    assert!(resp.get("error").is_none(), "search should succeed: {resp}");
    let result = &resp["result"];
    let packages = result["packages"].as_array().expect("packages array");
    assert!(!packages.is_empty(), "should return at least one package");

    // The first result should be Newtonsoft.Json itself.
    let first = &packages[0];
    assert_eq!(first["id"].as_str().unwrap(), "Newtonsoft.Json");
    assert!(first["version"].as_str().is_some(), "should have version");
    assert!(
        first["downloadCount"].as_u64().unwrap() > 0,
        "should have downloads"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_search_empty_query_returns_popular_packages() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/search",
        json!({
            "query": "",
            "projectPath": nuget_test_project(),
            "prerelease": false,
            "take": 10,
            "skip": 0,
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "empty search should succeed: {resp}"
    );
    let result = &resp["result"];
    let packages = result["packages"].as_array().expect("packages array");
    // Empty query still returns results (whatever nuget.org returns for "").
    assert!(
        result["totalHits"].as_u64().is_some(),
        "should have totalHits"
    );

    // Verify package structure.
    if !packages.is_empty() {
        let pkg = &packages[0];
        assert!(pkg["id"].as_str().is_some(), "package should have id");
        assert!(
            pkg["version"].as_str().is_some(),
            "package should have version"
        );
    }

    client.shutdown_and_exit();
}

#[test]
fn nuget_search_marks_installed_packages() {
    let mut client = LspClient::start();
    client.initialize();

    // The fixture project has Newtonsoft.Json installed.
    let resp = client.request(
        "forge/nuget/search",
        json!({
            "query": "Newtonsoft.Json",
            "projectPath": nuget_test_project(),
            "prerelease": false,
            "take": 5,
            "skip": 0,
        }),
    );

    assert!(resp.get("error").is_none(), "search should succeed: {resp}");
    let packages = resp["result"]["packages"].as_array().expect("packages");
    let newtonsoft = packages
        .iter()
        .find(|p| p["id"].as_str() == Some("Newtonsoft.Json"))
        .expect("Newtonsoft.Json should be in results");

    assert_eq!(
        newtonsoft["isInstalled"].as_bool(),
        Some(true),
        "Newtonsoft.Json should be marked as installed"
    );
    assert!(
        newtonsoft["installedVersion"].as_str().is_some(),
        "should have installedVersion"
    );

    client.shutdown_and_exit();
}

// ── forge/nuget/versions ────────────────────────────────────────

#[test]
fn nuget_versions_returns_version_list() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/versions",
        json!({ "packageId": "Newtonsoft.Json" }),
    );

    assert!(
        resp.get("error").is_none(),
        "versions should succeed: {resp}"
    );
    let versions = resp["result"]["versions"]
        .as_array()
        .expect("versions array");
    assert!(!versions.is_empty(), "should return versions");

    // Newest first — first version should be >= 13.x.
    let first = versions[0].as_str().unwrap();
    assert!(
        first.starts_with("13.") || first.starts_with("14."),
        "newest version should be recent: {first}"
    );

    // Should contain 13.0.3 somewhere.
    assert!(
        versions.iter().any(|v| v.as_str() == Some("13.0.3")),
        "should contain 13.0.3"
    );

    client.shutdown_and_exit();
}

// ── forge/nuget/installed ───────────────────────────────────────

#[test]
fn nuget_installed_returns_packages_for_test_project() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/installed",
        json!({ "projectPath": nuget_test_project() }),
    );

    assert!(
        resp.get("error").is_none(),
        "installed should succeed: {resp}"
    );
    let packages = resp["result"]["packages"]
        .as_array()
        .expect("packages array");
    assert!(!packages.is_empty(), "fixture project has packages");

    let newtonsoft = packages
        .iter()
        .find(|p| p["id"].as_str() == Some("Newtonsoft.Json"))
        .expect("Newtonsoft.Json should be installed");
    assert!(
        newtonsoft["resolvedVersion"].as_str().is_some(),
        "should have resolvedVersion"
    );

    client.shutdown_and_exit();
}

// ── forge/nuget/install + uninstall ─────────────────────────────

#[test]
fn nuget_install_and_uninstall_package() {
    let mut client = LspClient::start();
    client.initialize();

    let project = nuget_test_project();

    // Install a small package that isn't already in the fixture.
    let install_resp = client.request(
        "forge/nuget/install",
        json!({
            "projectPath": project,
            "packageId": "Microsoft.Extensions.Logging.Abstractions",
            "version": "9.0.0",
        }),
    );

    assert!(
        install_resp.get("error").is_none(),
        "install should succeed: {install_resp}"
    );
    assert_eq!(
        install_resp["result"]["success"].as_bool(),
        Some(true),
        "install should report success"
    );
    assert!(
        install_resp["result"]["message"].as_str().is_some(),
        "install should have message"
    );

    // Verify it shows up in installed list.
    let installed = client.request("forge/nuget/installed", json!({ "projectPath": project }));
    let packages = installed["result"]["packages"]
        .as_array()
        .expect("installed packages");
    assert!(
        packages
            .iter()
            .any(|p| p["id"].as_str() == Some("Microsoft.Extensions.Logging.Abstractions")),
        "installed package should appear in list"
    );

    // Uninstall it.
    let uninstall_resp = client.request(
        "forge/nuget/uninstall",
        json!({
            "projectPath": project,
            "packageId": "Microsoft.Extensions.Logging.Abstractions",
        }),
    );

    assert!(
        uninstall_resp.get("error").is_none(),
        "uninstall should succeed: {uninstall_resp}"
    );
    assert_eq!(
        uninstall_resp["result"]["success"].as_bool(),
        Some(true),
        "uninstall should report success"
    );

    // Verify it's gone from installed list.
    let installed_after =
        client.request("forge/nuget/installed", json!({ "projectPath": project }));
    let packages_after = installed_after["result"]["packages"]
        .as_array()
        .expect("installed packages after");
    assert!(
        !packages_after
            .iter()
            .any(|p| p["id"].as_str() == Some("Microsoft.Extensions.Logging.Abstractions")),
        "uninstalled package should not appear in list"
    );

    client.shutdown_and_exit();
}

// ── Error handling ──────────────────────────────────────────────

#[test]
fn nuget_installed_invalid_project_path_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/installed",
        json!({ "projectPath": "/nonexistent/path/Fake.csproj" }),
    );

    assert!(
        resp.get("error").is_some(),
        "should return error for invalid project path: {resp}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_versions_nonexistent_package_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/versions",
        json!({ "packageId": "ThisPackageDoesNotExist_XYZ_12345" }),
    );

    assert!(
        resp.get("error").is_some(),
        "should return error for nonexistent package: {resp}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_invalid_project_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/install",
        json!({
            "projectPath": "/nonexistent/Fake.csproj",
            "packageId": "Newtonsoft.Json",
            "version": "13.0.3",
        }),
    );

    // The handler returns success=false rather than an LSP error,
    // because dotnet CLI failures are expected business logic.
    assert!(
        resp.get("error").is_none(),
        "should not be an LSP error: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(false),
        "install should report failure for invalid project"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_uninstall_invalid_project_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "forge/nuget/uninstall",
        json!({
            "projectPath": "/nonexistent/Fake.csproj",
            "packageId": "Newtonsoft.Json",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "should not be an LSP error: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(false),
        "uninstall should report failure for invalid project"
    );

    client.shutdown_and_exit();
}

// ── Cache behavior ──────────────────────────────────────────────

#[test]
fn nuget_search_cache_returns_consistent_results() {
    let mut client = LspClient::start();
    client.initialize();

    let params = json!({
        "query": "Serilog",
        "projectPath": nuget_test_project(),
        "prerelease": false,
        "take": 3,
        "skip": 0,
    });

    let resp1 = client.request("forge/nuget/search", params.clone());
    let resp2 = client.request("forge/nuget/search", params);

    assert!(resp1.get("error").is_none(), "first search should succeed");
    assert!(resp2.get("error").is_none(), "second search should succeed");

    // Both should return the same result (cache hit on second).
    let pkgs1 = resp1["result"]["packages"].as_array().unwrap();
    let pkgs2 = resp2["result"]["packages"].as_array().unwrap();
    assert_eq!(pkgs1.len(), pkgs2.len(), "cached result should match");

    if !pkgs1.is_empty() {
        assert_eq!(
            pkgs1[0]["id"].as_str(),
            pkgs2[0]["id"].as_str(),
            "same first package"
        );
    }

    client.shutdown_and_exit();
}
