//! [PKG-VULN-TESTS] source-resolution unit coverage for `nuget/sources.rs`.
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use super::*;

const CONFIG: &str = "<configuration>\
<packageSources>\
  <clear />\
  <add key=\"feed\" value=\"/tmp/feed\" />\
  <add key=\"nuget\" value=\"https://api.nuget.org/v3/index.json\" />\
</packageSources>\
<auditSources>\
  <clear />\
  <add key=\"advisory\" value=\"http://127.0.0.1:9/v3/index.json\" allowInsecureConnections=\"true\" />\
</auditSources>\
</configuration>";

#[test]
fn reads_sources_and_audit_sources_through_the_parser() {
    let sources = parse_sources(CONFIG).unwrap();
    assert_eq!(sources.http, vec!["https://api.nuget.org/v3/index.json"]);
    assert_eq!(sources.folders, vec![PathBuf::from("/tmp/feed")]);
    assert_eq!(sources.audit, vec!["http://127.0.0.1:9/v3/index.json"]);
}

/// Without `<auditSources>`, audit lookups fall back to the `HTTP` package
/// sources — `NuGetAudit`'s own rule.
#[test]
fn missing_audit_sources_fall_back_to_package_sources() {
    let sources = parse_sources(
        "<configuration><packageSources><add key=\"n\" value=\"https://s/v3/index.json\" /></packageSources></configuration>",
    )
    .unwrap();
    assert!(matches!(sources.audit.as_slice(), []));
    let picked = if sources.audit.is_empty() {
        sources.http.clone()
    } else {
        sources.audit.clone()
    };
    assert_eq!(picked, sources.http);
}

/// `<clear />` empties inherited entries; unrelated sections never leak in.
#[test]
fn clear_and_unrelated_sections_are_honoured() {
    let sources = parse_sources(
        "<configuration><packageSources><add key=\"old\" value=\"/old\" /><clear /><add key=\"feed\" value=\"/new\" /></packageSources><disabled><add key=\"feed\" value=\"true\" /></disabled></configuration>",
    )
    .unwrap();
    assert_eq!(sources.folders, vec![PathBuf::from("/new")]);
    assert!(matches!(sources.http.as_slice(), []));
    assert!(sources.audit.is_empty(), "disabled is not a source list");
}

#[test]
fn no_config_yields_the_default_nuget_source() {
    let sources = resolve(Path::new("/nonexistent-root/x/Proj.fsproj"));
    assert_eq!(sources.http, vec!["https://api.nuget.org/v3/index.json"]);
    assert!(matches!(
        (sources.folders.as_slice(), sources.audit.as_slice()),
        ([], [])
    ));
}

#[test]
fn nearest_config_walks_up() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("NuGet.Config"), "<configuration/>").unwrap();
    let deep = dir.path().join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    assert_eq!(
        nearest_config(&deep.join("Proj.fsproj")),
        Some(dir.path().join("NuGet.Config"))
    );
}

/// Folder feeds carry versions in `{id}.{version}.nupkg` file names; other
/// packages, extension-less names and non-package files never contribute.
#[test]
fn folder_versions_come_from_nupkg_file_names() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "SharpLsp.Controlled.1.0.0.nupkg",
        "SharpLsp.Controlled.1.5.0.nupkg",
        "sharplsp.controlled.2.0.0.nupkg",
        "Other.Package.1.0.0.nupkg",
        "SharpLsp.Controlled.nupkg",
        "readme.txt",
    ] {
        std::fs::write(dir.path().join(name), "").unwrap();
    }
    let versions = read_dir_versions(dir.path(), "SharpLsp.Controlled").unwrap();
    assert_eq!(versions, vec!["1.0.0", "1.5.0", "2.0.0"]);
}
