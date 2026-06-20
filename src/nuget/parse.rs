//! Shared, read-only parsing of `MSBuild` package items.
//!
//! Mutation of project/props files always goes through [`super::xml_edit`]
//! (trivia-preserving). This module only *reads* ids/versions, mirroring the
//! line-oriented approach the rest of the `nuget` module already uses — it is
//! the single source of truth for "what `PackageReference` / `PackageVersion`
//! entries does this file declare?", reused by the installed-listing,
//! consolidation, and unused-package flows.

/// A `<PackageReference>` / `<PackageVersion>` entry read from an `MSBuild` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageItem {
    /// Package id (the `Include` attribute value).
    pub id: String,
    /// Version attribute value, if present (`None` for CPM versionless refs).
    pub version: Option<String>,
    /// Whether the element is a single self-closing line carrying only
    /// `Include` / `Version` — i.e. safe to move without losing item metadata
    /// (`PrivateAssets`, `Condition`, child elements, …).
    pub simple: bool,
}

/// Extract the value of an XML attribute (e.g. `Include="..."`) from a line.
pub fn extract_attr(line: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = line.find(&needle)? + needle.len();
    let rest = line.get(start..)?;
    let end = rest.find('"')?;
    Some(rest.get(..end)?.to_string())
}

/// Collect the attribute names present on an element line (`Include`, `Version`, …).
fn attribute_names(line: &str) -> Vec<String> {
    let mut names = Vec::new();
    for (idx, _) in line.match_indices("=\"") {
        let prefix = line.get(..idx).unwrap_or("");
        let reversed: String = prefix
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | ':'))
            .collect();
        if !reversed.is_empty() {
            names.push(reversed.chars().rev().collect());
        }
    }
    names
}

/// Whether an element line carries only `Include` / `Version` attributes and is
/// self-closing (so it can be hoisted/removed without dropping metadata).
fn is_simple(trimmed: &str) -> bool {
    trimmed.ends_with("/>")
        && attribute_names(trimmed)
            .iter()
            .all(|name| name == "Include" || name == "Version")
}

/// Read all `<{tag}>` package items from `MSBuild` file text.
///
/// `tag` is `"PackageReference"` or `"PackageVersion"`. Entries without an
/// `Include` attribute are skipped.
pub fn read_package_items(text: &str, tag: &str) -> Vec<PackageItem> {
    let open = format!("<{tag}");
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            if !trimmed.starts_with(&open) {
                return None;
            }
            let id = extract_attr(line, "Include")?;
            Some(PackageItem {
                id,
                version: extract_attr(line, "Version"),
                simple: is_simple(trimmed),
            })
        })
        .collect()
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    const CSPROJ: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Serilog" Version="3.1.0" />
    <PackageReference Include="StyleCop.Analyzers" Version="1.2.0" PrivateAssets="all" />
    <PackageReference Include="Versionless" />
  </ItemGroup>
</Project>
"#;

    #[test]
    fn extracts_attr_value() {
        let line = r#"    <PackageReference Include="Foo" Version="1.2.3" />"#;
        assert_eq!(extract_attr(line, "Include"), Some("Foo".to_string()));
        assert_eq!(extract_attr(line, "Version"), Some("1.2.3".to_string()));
        assert_eq!(extract_attr(line, "Missing"), None);
    }

    #[test]
    fn reads_all_package_references() {
        let items = read_package_items(CSPROJ, "PackageReference");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "Newtonsoft.Json",
                "Serilog",
                "StyleCop.Analyzers",
                "Versionless"
            ]
        );
    }

    #[test]
    fn versionless_reference_has_none_version() {
        let items = read_package_items(CSPROJ, "PackageReference");
        let versionless = items.iter().find(|i| i.id == "Versionless").unwrap();
        assert_eq!(versionless.version, None);
        assert!(versionless.simple);
    }

    #[test]
    fn reference_with_metadata_is_not_simple() {
        let items = read_package_items(CSPROJ, "PackageReference");
        let stylecop = items.iter().find(|i| i.id == "StyleCop.Analyzers").unwrap();
        assert!(
            !stylecop.simple,
            "PrivateAssets metadata must mark the entry non-simple"
        );
    }

    #[test]
    fn plain_reference_is_simple() {
        let items = read_package_items(CSPROJ, "PackageReference");
        let serilog = items.iter().find(|i| i.id == "Serilog").unwrap();
        assert!(serilog.simple);
    }

    #[test]
    fn reads_package_versions_from_props() {
        let props = r#"<Project>
  <ItemGroup>
    <PackageVersion Include="Serilog" Version="3.1.0" />
  </ItemGroup>
</Project>
"#;
        let items = read_package_items(props, "PackageVersion");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "Serilog");
        assert_eq!(items[0].version, Some("3.1.0".to_string()));
    }

    #[test]
    fn ignores_unrelated_tags() {
        let items = read_package_items(CSPROJ, "PackageVersion");
        assert!(items.is_empty());
    }
}
