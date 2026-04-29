//! End-to-end tests for `sharplsp/nuget/*` LSP custom requests.
//!
//! Tests spawn the `sharplsp-lsp` binary and communicate over stdio JSON-RPC,
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
#![expect(
    unused_results,
    reason = "test code — initialize() and I/O return values are intentionally discarded"
)]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};

use serde_json::{json, Value};
use tempfile::TempDir;

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
        let mut child = Command::new(env!("CARGO_BIN_EXE_sharplsp"))
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

/// Absolute path to the `NuGetTest` test fixture project (read-only — never mutate).
///
/// Tests that mutate the project file (install/uninstall) MUST use
/// [`isolated_nuget_project`] to copy the fixture into a temp dir first,
/// otherwise nextest's parallel execution races between mutating and
/// reading tests against the same shared file.
fn nuget_test_project() -> String {
    let manifest = env!("CARGO_MANIFEST_DIR");
    format!("{manifest}/tests/fixtures/NuGetTest/NuGetTest.csproj")
}

/// Copies the `NuGetTest` fixture into a fresh temp dir and returns
/// `(TempDir, csproj path)`. The `TempDir` must be kept alive for the
/// duration of the test — when it drops, the directory is removed.
fn isolated_nuget_project() -> (TempDir, String) {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let manifest = env!("CARGO_MANIFEST_DIR");
    let src = Path::new(manifest).join("tests/fixtures/NuGetTest/NuGetTest.csproj");
    let dst = tmp.path().join("NuGetTest.csproj");
    std::fs::copy(&src, &dst).expect("copy fixture csproj into tempdir");
    let dst_str = dst.to_string_lossy().into_owned();
    (tmp, dst_str)
}

// ── sharplsp/nuget/search ──────────────────────────────────────────

#[test]
fn nuget_search_returns_packages_for_known_query() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/search",
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
        "sharplsp/nuget/search",
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
        "sharplsp/nuget/search",
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

// ── sharplsp/nuget/versions ────────────────────────────────────────

#[test]
fn nuget_versions_returns_version_list() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/versions",
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

// ── sharplsp/nuget/installed ───────────────────────────────────────

#[test]
fn nuget_installed_returns_packages_for_test_project() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/installed",
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

// ── sharplsp/nuget/install + uninstall ─────────────────────────────

#[test]
fn nuget_install_and_uninstall_package() {
    let mut client = LspClient::start();
    client.initialize();

    // Use an isolated copy of the fixture so this mutating test does not
    // race against parallel read-only tests touching the shared csproj.
    let (_tmp, project) = isolated_nuget_project();

    // Install a small package that isn't already in the fixture.
    let install_resp = client.request(
        "sharplsp/nuget/install",
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
    let installed = client.request(
        "sharplsp/nuget/installed",
        json!({ "projectPath": project }),
    );
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
        "sharplsp/nuget/uninstall",
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
    let installed_after = client.request(
        "sharplsp/nuget/installed",
        json!({ "projectPath": project }),
    );
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

#[test]
fn nuget_uninstall_removes_multiline_package_reference_children() {
    let workspace = TempDir::new().unwrap();
    let props = workspace.path().join("Directory.Build.props");
    std::fs::write(
        &props,
        r#"<Project>
  <ItemGroup>
    <PackageReference Include="Outcome" Version="1.0.0" />
    <PackageReference Include="Exhaustion" Version="1.0.0">
      <PrivateAssets>all</PrivateAssets>
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
    </PackageReference>
  </ItemGroup>
</Project>
"#,
    )
    .unwrap();

    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/uninstall",
        json!({
            "target": {
                "id": props.to_str().unwrap(),
                "kind": "buildProps",
                "displayName": "Directory.Build.props",
                "path": props.to_str().unwrap(),
            },
            "packageId": "Exhaustion",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "uninstall should succeed: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(true),
        "uninstall should report success"
    );

    let text_after = std::fs::read_to_string(&props).unwrap();
    assert!(
        text_after.contains("<PackageReference Include=\"Outcome\" Version=\"1.0.0\" />"),
        "unrelated package should remain: {text_after}"
    );
    assert!(
        !text_after.contains("Exhaustion"),
        "removed package opening element should be gone: {text_after}"
    );
    assert!(
        !text_after.contains("<PrivateAssets>"),
        "removed package child elements should be gone: {text_after}"
    );
    assert!(
        !text_after.contains("<IncludeAssets>"),
        "removed package child elements should be gone: {text_after}"
    );
    assert!(
        !text_after.contains("</PackageReference>"),
        "removed package closing element should be gone: {text_after}"
    );

    client.shutdown_and_exit();
}

// ── Error handling ──────────────────────────────────────────────

#[test]
fn nuget_installed_invalid_project_path_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/installed",
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
        "sharplsp/nuget/versions",
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
        "sharplsp/nuget/install",
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
        "sharplsp/nuget/uninstall",
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

    let resp1 = client.request("sharplsp/nuget/search", params.clone());
    let resp2 = client.request("sharplsp/nuget/search", params);

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

// ── Workspace enumeration + CPM + buildProps coverage ────────────

fn write_file(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

const BARE_CSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" />
  </ItemGroup>
</Project>
"#;

const BARE_FSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
"#;

const CPM_PACKAGES_PROPS: &str = r#"<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
"#;

const BUILD_PROPS: &str = r#"<Project>
  <ItemGroup>
    <PackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0.0" />
  </ItemGroup>
</Project>
"#;

/// Build a CPM-enabled mixed-language workspace in a tempdir.
fn make_cpm_workspace() -> TempDir {
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "src/App/App.csproj", BARE_CSPROJ);
    write_file(root, "src/Lib/Lib.fsproj", BARE_FSPROJ);
    write_file(root, "Directory.Packages.props", CPM_PACKAGES_PROPS);
    write_file(root, "Directory.Build.props", BUILD_PROPS);
    // Junk that should be skipped.
    write_file(root, "src/App/bin/Debug/App.dll", "");
    write_file(root, "src/App/obj/project.assets.json", "{}");
    td
}

#[test]
fn nuget_targets_enumerates_cpm_workspace() {
    let workspace = make_cpm_workspace();
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/targets",
        json!({ "workspaceRoot": workspace.path().to_str().unwrap() }),
    );

    assert!(
        resp.get("error").is_none(),
        "targets should succeed: {resp}"
    );

    let result = &resp["result"];
    let targets = result["targets"].as_array().expect("targets array");

    // Two projects + two props files.
    let projects: Vec<&Value> = targets
        .iter()
        .filter(|t| t["kind"].as_str() == Some("project"))
        .collect();
    let props: Vec<&Value> = targets
        .iter()
        .filter(|t| t["kind"].as_str() == Some("buildProps"))
        .collect();
    assert_eq!(
        projects.len(),
        2,
        "should enumerate 2 projects: {targets:?}"
    );
    assert_eq!(
        props.len(),
        2,
        "should enumerate 2 props files: {targets:?}"
    );

    // Default target is the first project (alpha-ordered).
    assert!(
        result["defaultTargetId"].as_str().is_some(),
        "defaultTargetId set when targets present"
    );

    // CPM enabled because Directory.Packages.props contains the switch.
    assert_eq!(
        result["cpmEnabled"].as_bool(),
        Some(true),
        "CPM should be detected"
    );
    assert!(
        result["cpmFile"].as_str().is_some(),
        "cpmFile should be set"
    );

    // F# project language reported via from_project_path (types.rs:50).
    let fsharp = projects
        .iter()
        .find(|p| p["path"].as_str().is_some_and(|s| s.ends_with(".fsproj")))
        .expect("fsproj target");
    assert_eq!(fsharp["language"].as_str(), Some("fsharp"));

    client.shutdown_and_exit();
}

#[test]
fn nuget_targets_nonexistent_root_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/targets",
        json!({ "workspaceRoot": "/nonexistent/workspace/xyz" }),
    );

    assert!(
        resp.get("error").is_some(),
        "nonexistent root should fail: {resp}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_installed_on_build_props_target_scrapes_xml() {
    let workspace = make_cpm_workspace();
    let props_path = workspace.path().join("Directory.Packages.props");
    let mut client = LspClient::start();
    client.initialize();

    // Pass a full `target` object with kind=buildProps — exercises the
    // list_props_packages path instead of shelling out to `dotnet list`.
    let resp = client.request(
        "sharplsp/nuget/installed",
        json!({
            "target": {
                "id": props_path.to_str().unwrap(),
                "kind": "buildProps",
                "displayName": "Directory.Packages.props",
                "path": props_path.to_str().unwrap(),
            }
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "installed on buildProps should succeed: {resp}"
    );

    let packages = resp["result"]["packages"]
        .as_array()
        .expect("packages array");
    assert!(
        packages
            .iter()
            .any(|p| p["id"].as_str() == Some("Newtonsoft.Json")),
        "should scrape Newtonsoft.Json from Directory.Packages.props"
    );
}

#[test]
fn nuget_install_cpm_writes_project_and_props() {
    let workspace = make_cpm_workspace();
    let csproj = workspace.path().join("src/App/App.csproj");
    let props = workspace.path().join("Directory.Packages.props");
    let mut client = LspClient::start();
    client.initialize();

    // Install via a full `target` object (kind=project). Because a
    // Directory.Packages.props exists upwards, the handler should:
    //   1. add a versionless <PackageReference> to the csproj
    //   2. add a <PackageVersion> to Directory.Packages.props
    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "target": {
                "id": csproj.to_str().unwrap(),
                "kind": "project",
                "displayName": "App.csproj",
                "path": csproj.to_str().unwrap(),
                "language": "csharp",
            },
            "packageId": "Serilog",
            "version": "3.1.1",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "CPM install should succeed: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(true),
        "CPM install should report success"
    );

    let modified = resp["result"]["modifiedFiles"]
        .as_array()
        .expect("modifiedFiles array");
    assert!(
        !modified.is_empty(),
        "CPM install should report modified files"
    );

    // csproj gets a versionless reference.
    let csproj_text = std::fs::read_to_string(&csproj).unwrap();
    assert!(
        csproj_text.contains("<PackageReference Include=\"Serilog\" />"),
        "csproj should have versionless Serilog reference: {csproj_text}"
    );
    // props file gets the version entry.
    let props_text = std::fs::read_to_string(&props).unwrap();
    assert!(
        props_text.contains("<PackageVersion Include=\"Serilog\" Version=\"3.1.1\""),
        "props file should have Serilog version: {props_text}"
    );

    // No-op re-install leaves everything untouched (but still succeeds).
    let resp2 = client.request(
        "sharplsp/nuget/install",
        json!({
            "target": {
                "id": csproj.to_str().unwrap(),
                "kind": "project",
                "displayName": "App.csproj",
                "path": csproj.to_str().unwrap(),
                "language": "csharp",
            },
            "packageId": "Serilog",
            "version": "3.1.1",
        }),
    );
    assert!(
        resp2.get("error").is_none(),
        "no-op install should succeed: {resp2}"
    );
    assert_eq!(
        resp2["result"]["success"].as_bool(),
        Some(true),
        "no-op install reports success"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_on_build_props_target_edits_props_file() {
    let workspace = make_cpm_workspace();
    let build_props = workspace.path().join("Directory.Build.props");
    let mut client = LspClient::start();
    client.initialize();

    // Install directly into a Directory.Build.props (kind=buildProps).
    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "target": {
                "id": build_props.to_str().unwrap(),
                "kind": "buildProps",
                "displayName": "Directory.Build.props (solution root)",
                "path": build_props.to_str().unwrap(),
            },
            "packageId": "StyleCop.Analyzers",
            "version": "1.2.0-beta.556",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "buildProps install should succeed: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(true),
        "buildProps install should report success"
    );

    let text = std::fs::read_to_string(&build_props).unwrap();
    assert!(
        text.contains("StyleCop.Analyzers"),
        "Directory.Build.props should contain StyleCop.Analyzers: {text}"
    );
    assert!(
        text.contains("Microsoft.SourceLink.GitHub"),
        "original entries should be preserved: {text}"
    );

    // Uninstall it again — exercises remove_package happy path on a props file.
    let uninstall = client.request(
        "sharplsp/nuget/uninstall",
        json!({
            "target": {
                "id": build_props.to_str().unwrap(),
                "kind": "buildProps",
                "displayName": "Directory.Build.props (solution root)",
                "path": build_props.to_str().unwrap(),
            },
            "packageId": "StyleCop.Analyzers",
        }),
    );
    assert!(
        uninstall.get("error").is_none(),
        "uninstall should succeed: {uninstall}"
    );
    assert_eq!(
        uninstall["result"]["success"].as_bool(),
        Some(true),
        "uninstall should report success"
    );

    let text_after = std::fs::read_to_string(&build_props).unwrap();
    assert!(
        !text_after.contains("StyleCop.Analyzers"),
        "StyleCop.Analyzers should be gone: {text_after}"
    );

    // Second uninstall is a no-op (package not present) — still a non-error
    // response, but `success=false` so the caller knows nothing changed.
    let noop = client.request(
        "sharplsp/nuget/uninstall",
        json!({
            "target": {
                "id": build_props.to_str().unwrap(),
                "kind": "buildProps",
                "displayName": "Directory.Build.props (solution root)",
                "path": build_props.to_str().unwrap(),
            },
            "packageId": "StyleCop.Analyzers",
        }),
    );
    assert!(
        noop.get("error").is_none(),
        "no-op uninstall should not error: {noop}"
    );
    assert_eq!(
        noop["result"]["success"].as_bool(),
        Some(false),
        "no-op uninstall reports success=false"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_non_cpm_inserts_version_into_versionless_reference() {
    // Workspace WITHOUT Directory.Packages.props — exercises the
    // `Reference` element path where an existing `<PackageReference
    // Include="X"/>` must have a Version attribute inserted.
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "App.csproj", BARE_CSPROJ);
    let csproj = root.join("App.csproj");

    let mut client = LspClient::start();
    client.initialize();

    // Newtonsoft.Json already in BARE_CSPROJ without a Version — install
    // should replace the element by inserting the Version attribute.
    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "projectPath": csproj.to_str().unwrap(),
            "packageId": "Newtonsoft.Json",
            "version": "13.0.4",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "install should succeed: {resp}"
    );
    assert_eq!(
        resp["result"]["success"].as_bool(),
        Some(true),
        "install reports success"
    );

    let text = std::fs::read_to_string(&csproj).unwrap();
    assert!(
        text.contains("Include=\"Newtonsoft.Json\" Version=\"13.0.4\""),
        "Newtonsoft.Json should now have Version=13.0.4: {text}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_cpm_strips_version_from_existing_reference() {
    // Start with a versioned reference then install via the CPM path —
    // exercises `strip_version_attr` in xml_edit.
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(
        root,
        "App.csproj",
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
  </ItemGroup>
</Project>
"#,
    );
    write_file(root, "Directory.Packages.props", CPM_PACKAGES_PROPS);
    let csproj = root.join("App.csproj");

    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "projectPath": csproj.to_str().unwrap(),
            "packageId": "Newtonsoft.Json",
            "version": "13.0.4",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "install should succeed: {resp}"
    );

    let text = std::fs::read_to_string(&csproj).unwrap();
    assert!(
        text.contains("<PackageReference Include=\"Newtonsoft.Json\" />"),
        "Version attr should have been stripped: {text}"
    );
    assert!(
        !text.contains("Version=\"13.0.3\""),
        "old Version should not remain: {text}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_creates_item_group_when_none_exists() {
    // csproj with no <ItemGroup> at all — exercises `create_item_group_with`.
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(
        root,
        "Empty.csproj",
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
"#,
    );
    let csproj = root.join("Empty.csproj");

    let mut client = LspClient::start();
    client.initialize();

    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "projectPath": csproj.to_str().unwrap(),
            "packageId": "Serilog",
            "version": "3.1.1",
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "install should succeed: {resp}"
    );

    let text = std::fs::read_to_string(&csproj).unwrap();
    assert!(
        text.contains("<ItemGroup>"),
        "a new ItemGroup should have been created: {text}"
    );
    assert!(
        text.contains("Include=\"Serilog\" Version=\"3.1.1\""),
        "Serilog should be inside the new ItemGroup: {text}"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_search_with_fsproj_project_path_hits_fsharp_branch() {
    // Use a legacy `projectPath` ending in .fsproj to exercise the
    // `TargetLanguage::FSharp` branch in `NuGetTarget::from_project_path`.
    let td = TempDir::new().unwrap();
    let root = td.path();
    write_file(root, "Lib.fsproj", BARE_FSPROJ);
    let fsproj = root.join("Lib.fsproj");

    let mut client = LspClient::start();
    client.initialize();

    // Note: deliberately omit `take` so `default_take` is exercised.
    let resp = client.request(
        "sharplsp/nuget/search",
        json!({
            "query": "Serilog",
            "projectPath": fsproj.to_str().unwrap(),
            "prerelease": false,
        }),
    );

    assert!(
        resp.get("error").is_none(),
        "search with fsproj should succeed: {resp}"
    );
    assert!(
        resp["result"]["packages"].is_array(),
        "packages array present"
    );

    client.shutdown_and_exit();
}

#[test]
fn nuget_install_missing_params_returns_error() {
    let mut client = LspClient::start();
    client.initialize();

    // Neither target nor projectPath — resolve_target should bail.
    let resp = client.request(
        "sharplsp/nuget/install",
        json!({
            "packageId": "Serilog",
            "version": "3.1.1",
        }),
    );

    assert!(
        resp.get("error").is_some(),
        "missing target should return error: {resp}"
    );

    client.shutdown_and_exit();
}
