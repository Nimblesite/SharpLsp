//! Real-source bounded update request coverage. [NUGET-REQUESTS-UPDATE-TESTS]
#![expect(clippy::unwrap_used, reason = "test failures should panic")]
#![expect(clippy::expect_used, reason = "test failures should panic")]
#![expect(
    clippy::indexing_slicing,
    reason = "JSON assertions index test responses"
)]
#![expect(
    unused_results,
    reason = "test client I/O results are intentionally discarded"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

#[path = "support/lsp_client.rs"]
mod lsp_client;
use lsp_client::{require_dotnet, LspClient};
use serde_json::{json, Value};

const PACKAGE: &str = "SharpLsp.Controlled";

struct Feed {
    _workspace: TempDir,
    root: PathBuf,
}

/// Pack a closed inventory into a local source used by every real project.
fn controlled_feed() -> Option<Feed> {
    if !require_dotnet() {
        return None;
    }
    let workspace = tempfile::tempdir().expect("temporary update workspace");
    let root = workspace.path().to_path_buf();
    for version in ["1.0.0", "1.2.0", "2.0.0", "1.3.0-beta.1"] {
        pack(&root, version);
    }
    write(
        &root.join("NuGet.Config"),
        &format!(
            "<?xml version=\"1.0\"?><configuration><packageSources><clear /><add key=\"controlled\" value=\"{}\" /></packageSources></configuration>",
            root.join("feed").display()
        ),
    );
    Some(Feed {
        _workspace: workspace,
        root,
    })
}

/// Build and pack one controlled package version with the real SDK.
fn pack(root: &Path, version: &str) {
    let source = root.join("package-source");
    if !source.exists() {
        let status = Command::new("dotnet")
            .args(["new", "classlib", "--output"])
            .arg(&source)
            .status()
            .expect("create controlled package");
        assert!(status.success());
    }
    let output = Command::new("dotnet")
        .args(["pack"])
        .arg(&source)
        .args(["--output"])
        .arg(root.join("feed"))
        .arg(format!("-p:PackageId={PACKAGE}"))
        .arg(format!("-p:PackageVersion={version}"))
        .output()
        .expect("pack controlled package");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Write a real C# or F# SDK project with one direct package declaration.
fn project(feed: &Feed, name: &str, extension: &str, version: &str) -> PathBuf {
    let directory = feed.root.join(name);
    let path = directory.join(format!("{name}.{extension}"));
    write(
        &path,
        &format!(
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include=\"{PACKAGE}\" Version=\"{version}\" /></ItemGroup></Project>"
        ),
    );
    if extension == "fsproj" {
        write(&directory.join("Library.fs"), "namespace Controlled\n");
    }
    path
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create fixture parent");
    }
    std::fs::write(path, text).expect("write fixture");
}

fn preview(client: &mut LspClient, path: &Path) -> Value {
    client.request(
        "sharplsp/nuget/updatePreview",
        json!({"projectPath": path.to_string_lossy(), "packageId": PACKAGE}),
    )
}

#[test]
fn fsharp_and_csharp_preview_the_bounded_stable_feed_version() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize();
    for (name, extension) in [("FSharpBounded", "fsproj"), ("CSharpBounded", "csproj")] {
        let path = project(&feed, name, extension, "1.0.0");
        let before = std::fs::read(&path).unwrap();
        let response = preview(&mut client, &path);
        assert!(
            response.get("error").is_none(),
            "preview failed: {response}"
        );
        let result = &response["result"];
        assert_eq!(result["currentVersion"].as_str(), Some("1.0.0"));
        assert_eq!(result["proposedVersion"].as_str(), Some("1.2.0"));
        assert_ne!(result["proposedVersion"].as_str(), Some("2.0.0"));
        assert_ne!(result["proposedVersion"].as_str(), Some("1.3.0-beta.1"));
        assert_eq!(std::fs::read(&path).unwrap(), before, "preview never edits");
    }
    client.shutdown_and_exit();
}

#[test]
fn no_candidate_and_unavailable_feed_never_edit_the_project() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    let current = project(&feed, "AlreadyCurrent", "fsproj", "1.2.0");
    let before = std::fs::read(&current).unwrap();
    let response = preview(&mut client, &current);
    assert_eq!(response["result"]["proposedVersion"], Value::Null);
    assert_eq!(
        response["result"]["message"].as_str(),
        Some("Already up to date within this version line")
    );
    assert_eq!(std::fs::read(&current).unwrap(), before);
    let unavailable = project(&feed, "UnavailableFeed", "csproj", "1.0.0");
    let unavailable_before = std::fs::read(&unavailable).unwrap();
    write(&feed.root.join("NuGet.Config"), "<configuration><packageSources><clear /><add key=\"missing\" value=\"missing-feed\" /></packageSources></configuration>");
    let failure = preview(&mut client, &unavailable);
    assert!(
        failure.get("error").is_some(),
        "feed failure must be visible: {failure}"
    );
    assert_eq!(std::fs::read(&unavailable).unwrap(), unavailable_before);
    client.shutdown_and_exit();
}

#[test]
fn cpm_preview_and_install_update_only_the_owning_props_version() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let directory = feed.root.join("CpmUpdate");
    let path = directory.join("CpmUpdate.fsproj");
    write(&path, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Compile Include=\"Library.fs\" /><PackageReference Include=\"SharpLsp.Controlled\" /></ItemGroup></Project>");
    write(&directory.join("Library.fs"), "namespace Cpm\n");
    let props = directory.join("Directory.Packages.props");
    write(&props, "<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include=\"SharpLsp.Controlled\" Version=\"1.0.0\" /></ItemGroup></Project>");
    // One project shares the central version; one does not use the package.
    let sibling = directory.join("Sibling").join("Sibling.csproj");
    write(&sibling, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>\n<PackageReference Include=\"SharpLsp.Controlled\" />\n</ItemGroup></Project>");
    let unrelated = directory.join("Unrelated").join("Unrelated.csproj");
    write(&unrelated, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>");
    let project_before = std::fs::read(&path).unwrap();
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    let response = preview(&mut client, &path);
    assert_eq!(
        response["result"]["proposedVersion"].as_str(),
        Some("1.2.0")
    );
    assert_eq!(response["result"]["versionOwner"].as_str(), props.to_str());
    // [NUGET-REQUESTS-UPDATE-CONFIRM]: the preview names every project the props version moves.
    let mut affected: Vec<&str> = response["result"]["affectedProjects"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    affected.sort_unstable();
    let mut expected = vec![path.to_str().unwrap(), sibling.to_str().unwrap()];
    expected.sort_unstable();
    assert_eq!(affected, expected, "{response}");
    let install = client.request(
        "sharplsp/nuget/install",
        json!({
            "projectPath": path.to_string_lossy(), "packageId": PACKAGE,
            "version": "1.2.0", "expectedVersion": "1.0.0"
        }),
    );
    assert!(
        install.get("error").is_none(),
        "CPM install failed: {install}"
    );
    assert_eq!(
        install["result"]["success"].as_bool(),
        Some(true),
        "{install}"
    );
    assert!(install["result"]["modifiedFiles"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file.as_str() == props.to_str()));
    assert!(std::fs::read_to_string(&props)
        .unwrap()
        .contains("Version=\"1.2.0\""));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        project_before,
        "versionless F# reference is unchanged"
    );
    client.shutdown_and_exit();
}

#[test]
fn stale_preview_is_rejected_before_install_or_sidecar_edit() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    let path = project(&feed, "StalePreview", "csproj", "1.0.0");
    let response = preview(&mut client, &path);
    assert_eq!(
        response["result"]["proposedVersion"].as_str(),
        Some("1.2.0")
    );
    project(&feed, "StalePreview", "csproj", "2.0.0");
    let before = std::fs::read(&path).unwrap();
    let install = client.request(
        "sharplsp/nuget/install",
        json!({
            "projectPath": path.to_string_lossy(),
            "packageId": PACKAGE,
            "version": "1.2.0",
            "expectedVersion": "1.0.0"
        }),
    );
    assert!(
        install.get("error").is_some(),
        "stale apply must fail: {install}"
    );
    assert!(install["error"]["message"]
        .as_str()
        .unwrap()
        .contains("refresh the update preview"));
    assert_eq!(
        std::fs::read(&path).unwrap(),
        before,
        "stale apply never edits"
    );
    client.shutdown_and_exit();
}
