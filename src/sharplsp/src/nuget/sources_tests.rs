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

/// The sources merged from `configs` (lowest priority first), each written
/// into its own nested directory.
fn merged(configs: &[&str]) -> (tempfile::TempDir, Sources) {
    let dir = tempfile::tempdir().unwrap();
    let mut chain = Vec::new();
    let mut at = dir.path().to_path_buf();
    for config in configs {
        at = at.join("d");
        std::fs::create_dir_all(&at).unwrap();
        std::fs::write(at.join("NuGet.Config"), config).unwrap();
        chain.push(at.join("NuGet.Config"));
    }
    let sources = resolve_chain(&chain);
    (dir, sources)
}

#[test]
fn reads_sources_and_audit_sources_through_the_parser() {
    let (_dir, sources) = merged(&[CONFIG]);
    assert_eq!(sources.http, vec!["https://api.nuget.org/v3/index.json"]);
    assert_eq!(sources.folders, vec![PathBuf::from("/tmp/feed")]);
    assert_eq!(sources.audit, vec!["http://127.0.0.1:9/v3/index.json"]);
    assert_eq!(
        sources.audit_sources(),
        vec!["http://127.0.0.1:9/v3/index.json"]
    );
}

/// Without `<auditSources>`, audit lookups fall back to the `HTTP` package
/// sources — `NuGetAudit`'s own rule.
#[test]
fn missing_audit_sources_fall_back_to_package_sources() {
    let (_dir, sources) = merged(&[
        "<configuration><packageSources><add key=\"n\" value=\"https://s/v3/index.json\" /></packageSources></configuration>",
    ]);
    assert!(sources.audit.is_empty());
    assert_eq!(sources.audit_sources(), vec!["https://s/v3/index.json"]);
}

/// `<clear />` empties inherited entries, a nearer key overrides a farther
/// one, a disabled key hides its source, and relative feeds resolve against
/// their own config's directory.
#[test]
fn chain_merges_clears_overrides_and_disables() {
    let (dir, sources) = merged(&[
        "<configuration><packageSources><add key=\"gone\" value=\"/gone\" /></packageSources></configuration>",
        "<configuration><packageSources><clear /><add key=\"feed\" value=\"feed\" /><add key=\"off\" value=\"/off\" /><add key=\"web\" value=\"https://far/v3/index.json\" /></packageSources></configuration>",
        "<configuration><packageSources><add key=\"WEB\" value=\"https://near/v3/index.json\" /></packageSources><disabledPackageSources><add key=\"off\" value=\"true\" /></disabledPackageSources></configuration>",
    ]);
    assert_eq!(
        sources.folders,
        vec![dir.path().join("d").join("d").join("feed")]
    );
    assert_eq!(sources.http, vec!["https://near/v3/index.json"]);
    assert!(sources.audit.is_empty(), "no audit list was declared");
}

/// A chain that never declares `<packageSources>` — no config at all, or one
/// holding only audit sources — restores from nuget.org.
#[test]
fn undeclared_package_sources_default_to_nuget_org() {
    for configs in [
        &[][..],
        &["<configuration><auditSources><add key=\"a\" value=\"https://a/v3/index.json\" /></auditSources></configuration>"][..],
    ] {
        let (_dir, sources) = merged(configs);
        assert_eq!(sources.http, vec!["https://api.nuget.org/v3/index.json"]);
        assert!(sources.folders.is_empty());
    }
    let (_dir, cleared) =
        merged(&["<configuration><packageSources><clear /></packageSources></configuration>"]);
    assert!(cleared.http.is_empty(), "an explicit clear means none");
}

/// The chain lists every ancestor's config, farthest first, in any casing.
#[test]
fn config_chain_walks_up_in_any_casing() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("NuGet.Config"), "<configuration/>").unwrap();
    let deep = dir.path().join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(deep.join("nuget.config"), "<configuration/>").unwrap();
    let chain = crate::paths::nuget_config_chain(&deep.join("Proj.fsproj"));
    let ours: Vec<_> = chain
        .iter()
        .filter(|path| path.starts_with(dir.path()))
        .collect();
    assert_eq!(ours.len(), 2, "{chain:?}");
    assert!(crate::paths::has_file_name(ours[1], "NuGet.Config"));
    assert!(ours[1].starts_with(&deep), "nearest last: {chain:?}");
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
