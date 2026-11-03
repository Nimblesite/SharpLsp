//! Shared, read-only parsing of `MSBuild` package items.
//!
//! Mutation of project/props files always goes through [`super::edit`] (the C#
//! sidecar's `MSBuild` document model). This module only *reads* ids/versions —
//! it is the single source of truth for "what `PackageReference` /
//! `PackageVersion`
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

use anyhow::Result;
use quick_xml::{
    encoding::Decoder,
    events::{BytesStart, Event},
    Reader,
};

/// Extract a decoded attribute from an XML element, regardless of quote style.
#[cfg(test)]
pub fn extract_attr(line: &str, attr: &str) -> Option<String> {
    let mut reader = Reader::from_str(line);
    reader.config_mut().trim_text(true);
    match reader.read_event().ok()? {
        Event::Start(element) | Event::Empty(element) => {
            attribute_value(&element, attr, reader.decoder())
                .ok()
                .flatten()
        }
        _ => None,
    }
}

/// Decode entities through the XML parser, never through source-text matching.
fn attribute_value(
    element: &BytesStart<'_>,
    name: &str,
    decoder: Decoder,
) -> Result<Option<String>> {
    element
        .try_get_attribute(name)?
        .map(|attribute| {
            attribute
                .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, decoder)
                .map(std::borrow::Cow::into_owned)
                .map_err(Into::into)
        })
        .transpose()
}

/// A self-closing element with only identity/version attributes is safe to hoist.
fn package_item(
    element: &BytesStart<'_>,
    empty: bool,
    decoder: Decoder,
) -> Result<Option<PackageItem>> {
    let Some(id) = attribute_value(element, "Include", decoder)? else {
        return Ok(None);
    };
    let attributes = element
        .attributes()
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Some(PackageItem {
        id,
        version: attribute_value(element, "Version", decoder)?,
        simple: empty
            && attributes
                .iter()
                .all(|attribute| matches!(attribute.key.as_ref(), b"Include" | b"Version")),
    }))
}

/// Read all `<{tag}>` package items from `MSBuild` file text.
///
/// `tag` is `"PackageReference"` or `"PackageVersion"`. Entries without an
/// `Include` attribute are skipped.
pub fn read_package_items(text: &str, tag: &str) -> Vec<PackageItem> {
    read_items(text, tag).unwrap_or_else(|error| {
        tracing::warn!(%error, "Invalid MSBuild package XML");
        Vec::new()
    })
}

/// Read actual XML elements; comments and physical line breaks never define items.
fn read_items(text: &str, tag: &str) -> Result<Vec<PackageItem>> {
    let mut reader = Reader::from_str(text);
    let mut items = Vec::new();
    let mut conditions = Vec::new();
    loop {
        let event = reader.read_event()?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                let conditional = conditions.last().copied().unwrap_or(false)
                    || element.try_get_attribute("Condition")?.is_some();
                if element.name().as_ref() == tag.as_bytes() {
                    items.extend(package_item(
                        &element,
                        empty && !conditional,
                        reader.decoder(),
                    )?);
                }
                if !empty {
                    conditions.push(conditional);
                }
            }
            Event::End(_) => {
                let _ = conditions.pop();
            }
            Event::Eof => return Ok(items),
            _ => {}
        }
    }
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
        let conditional = read_package_items(
            r#"<Project><ItemGroup Condition="'$(TargetFramework)' == 'net10.0'"><PackageReference Include="Conditional" Version="1.0.0" /></ItemGroup></Project>"#,
            "PackageReference",
        );
        assert_eq!(conditional.len(), 1);
        assert!(
            !conditional[0].simple,
            "hoisting must preserve inherited conditions"
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
        assert!(matches!(items.as_slice(), []), "{items:?}");
    }
}
