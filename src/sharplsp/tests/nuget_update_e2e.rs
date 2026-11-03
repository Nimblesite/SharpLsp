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
    write(&sibling, "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include=\"SharpLsp.Controlled\" /></ItemGroup></Project>");
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
fn explicit_props_version_selection_preserves_shared_target_and_rejects_stale_edits() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    for (name, tag) in [
        ("Directory.Build.props", "PackageReference"),
        ("Directory.Packages.props", "PackageVersion"),
    ] {
        let directory = feed.root.join(name.replace('.', "_"));
        let props = directory.join(name);
        let entry = format!("<{tag} Include=\"{PACKAGE}\" Version=\"1.0.0\" />");
        let consumers = stage_props_scenario(&directory, name, tag, &entry);
        let updated = drive_explicit_props_update(&mut client, &props, name, &consumers);
        assert!(updated.contains("Version=\"2.0.0\""), "{updated}");
    }
    client.shutdown_and_exit();
}

/// Stage one props directory: the owning props entry, F#/C# consumer projects,
/// their solution, and a nested shadow props whose consumers must not move.
fn stage_props_scenario(directory: &Path, name: &str, tag: &str, entry: &str) -> Vec<PathBuf> {
    let central = tag == "PackageVersion";
    let config = if central {
        "<PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>"
    } else {
        ""
    };
    let props_text = format!("<Project>{config}\n<ItemGroup>\n{entry}\n</ItemGroup>\n</Project>");
    write(&directory.join(name), &props_text);
    let reference = if central {
        format!("<ItemGroup><PackageReference Include='{PACKAGE}' /></ItemGroup>")
    } else {
        String::new()
    };
    let consumers = [
        directory.join("FSharp/App.fsproj"),
        directory.join("CSharp/App.csproj"),
    ];
    for consumer in &consumers {
        write(consumer, &format!("<Project Sdk='Microsoft.NET.Sdk'><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>{reference}</Project>"));
    }
    write(&directory.join("App.slnx"), "<Solution><Project Path='FSharp/App.fsproj' /><Project Path='CSharp/App.csproj' /></Solution>");
    write(&directory.join("Shadow").join(name), &props_text);
    write(&directory.join("Shadow/Shadow.csproj"), &format!("<Project Sdk='Microsoft.NET.Sdk'><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>{reference}</Project>"));
    consumers.to_vec()
}

/// Preview an explicit 2.0.0 selection on the props declaration, apply it, and
/// reject a stale replay; returns the updated props text for representation
/// assertions. Implements [NUGET-REQUESTS-UPDATE-CONFIRM].
fn drive_explicit_props_update(
    client: &mut LspClient,
    props: &Path,
    name: &str,
    consumers: &[PathBuf],
) -> String {
    let target = json!({"id": props, "kind": "buildProps", "displayName": name, "path": props});
    let before = std::fs::read(props).unwrap();
    let response = client.request(
        "sharplsp/nuget/updatePreview",
        json!({
            "target": target, "packageId": PACKAGE, "selectedVersion": "2.0.0"
        }),
    );
    assert!(
        response.get("error").is_none(),
        "explicit props preview failed: {response}"
    );
    assert_eq!(response["result"]["target"], target);
    assert_eq!(response["result"]["versionOwner"].as_str(), props.to_str());
    assert_eq!(response["result"]["requestedVersion"], "1.0.0");
    assert_eq!(response["result"]["currentVersion"], "1.0.0");
    assert_eq!(response["result"]["proposedVersion"], "2.0.0");
    assert_eq!(response["result"]["boundary"], "major");
    let mut expected_consumers: Vec<_> = consumers
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    expected_consumers.sort();
    assert_eq!(
        response["result"]["affectedProjects"],
        json!(expected_consumers),
        "only consumers of this exact props file move"
    );
    assert_eq!(std::fs::read(props).unwrap(), before, "preview never edits");
    let install = client.request(
        "sharplsp/nuget/install",
        json!({
            "target": target, "packageId": PACKAGE, "version": "2.0.0",
            "expectedVersion": "1.0.0", "expectedRequestedVersion": "1.0.0"
        }),
    );
    assert_eq!(install["result"]["success"], true, "{install}");
    assert_eq!(install["result"]["modifiedFiles"], json!([props]));
    let updated = std::fs::read_to_string(props).unwrap();
    let stale = client.request(
        "sharplsp/nuget/install",
        json!({
            "target": target, "packageId": PACKAGE, "version": "1.2.0",
            "expectedVersion": "1.0.0", "expectedRequestedVersion": "1.0.0"
        }),
    );
    assert!(
        stale.get("error").is_some(),
        "stale props edit accepted: {stale}"
    );
    assert_eq!(std::fs::read_to_string(props).unwrap(), updated);
    updated
}

/// A conditional `<Version>` child is not one concrete declaration, so the props
/// preview must refuse it instead of claiming its text. [NUGET-REQUESTS-UPDATE-BOUNDS]
#[test]
fn conditional_child_version_stays_unresolved_for_props_preview() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    for (name, tag) in [
        ("Directory.Build.props", "PackageReference"),
        ("Directory.Packages.props", "PackageVersion"),
    ] {
        let directory = feed
            .root
            .join(format!("{}_ChildCond", name.replace('.', "_")));
        let props = directory.join(name);
        let entry = format!(
            "<{tag} Include=\"{PACKAGE}\">\n  <Version Condition=\"'$(Configuration)' == 'Release'\">1.0.0</Version>\n</{tag}>"
        );
        let _consumers = stage_props_scenario(&directory, name, tag, &entry);
        let before = std::fs::read(&props).unwrap();
        let response = client.request(
            "sharplsp/nuget/updatePreview",
            json!({
                "target": {"id": props, "kind": "buildProps", "displayName": name, "path": props},
                "packageId": PACKAGE, "selectedVersion": "2.0.0"
            }),
        );
        assert!(
            response.get("error").is_some(),
            "a conditional child value was claimed: {response}"
        );
        assert_eq!(
            std::fs::read(&props).unwrap(),
            before,
            "preview never edits"
        );
    }
    client.shutdown_and_exit();
}

/// A legacy child `<Version>` element, not an attribute, drives the same explicit
/// flow: the released v0.30.0 picker installed directly and the `MSBuild` DOM owns
/// the same metadata either way. [NUGET-REQUESTS-UPDATE-CONFIRM]
#[test]
fn explicit_props_version_selection_supports_child_version_metadata() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    for (name, tag) in [
        ("Directory.Build.props", "PackageReference"),
        ("Directory.Packages.props", "PackageVersion"),
    ] {
        let directory = feed.root.join(format!("{}_Child", name.replace('.', "_")));
        let props = directory.join(name);
        let entry = format!(
            "<{tag} Include=\"{PACKAGE}\">\n  <Version>1.0.0</Version>\n  <PrivateAssets>all</PrivateAssets>\n</{tag}>"
        );
        let consumers = stage_props_scenario(&directory, name, tag, &entry);
        let before = std::fs::read_to_string(&props).unwrap();
        let updated = drive_explicit_props_update(&mut client, &props, name, &consumers);
        assert_eq!(
            updated,
            before.replace("<Version>1.0.0</Version>", "<Version>2.0.0</Version>"),
            "the child element updates in place with formatting preserved"
        );
        assert!(
            !updated.contains("Version=\"2.0.0\""),
            "no attribute conversion: {updated}"
        );
        assert!(
            updated.contains("<PrivateAssets>all</PrivateAssets>"),
            "unrelated metadata survives: {updated}"
        );
    }
    client.shutdown_and_exit();
}

#[test]
fn explicit_version_picker_can_replace_a_range_only_after_preview() {
    let Some(feed) = controlled_feed() else {
        return;
    };
    let mut client = LspClient::start();
    client.initialize_with_root(&feed.root);
    for extension in ["fsproj", "csproj"] {
        let path = project(&feed, extension, extension, "[1.0.0,2.0.0)");
        let before = std::fs::read(&path).unwrap();
        let bounded = preview(&mut client, &path);
        assert!(
            bounded.get("error").is_some(),
            "a default update must preserve ranges: {bounded}"
        );
        let explicit = client.request(
            "sharplsp/nuget/updatePreview",
            json!({
                "projectPath": path, "packageId": PACKAGE, "selectedVersion": "2.0.0"
            }),
        );
        assert!(
            explicit.get("error").is_none(),
            "explicit range selection refused: {explicit}"
        );
        assert_eq!(explicit["result"]["requestedVersion"], "[1.0.0,2.0.0)");
        assert_eq!(explicit["result"]["currentVersion"], "1.0.0");
        assert_eq!(explicit["result"]["proposedVersion"], "2.0.0");
        assert_eq!(explicit["result"]["boundary"], "major");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "preview preserves the range"
        );
        let install = client.request("sharplsp/nuget/install", json!({
            "projectPath": path, "packageId": PACKAGE, "version": "2.0.0",
            "expectedVersion": "1.0.0", "expectedRequestedVersion": explicit["result"]["requestedVersion"]
        }));
        assert_eq!(install["result"]["success"], true, "{install}");
        let updated = std::fs::read_to_string(&path).unwrap();
        assert!(updated.contains("Version=\"2.0.0\""), "{updated}");
        let stale = client.request("sharplsp/nuget/install", json!({
            "projectPath": path, "packageId": PACKAGE, "version": "1.2.0",
            "expectedVersion": "1.0.0", "expectedRequestedVersion": explicit["result"]["requestedVersion"]
        }));
        assert!(stale.get("error").is_some(), "{stale}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), updated);
    }
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
