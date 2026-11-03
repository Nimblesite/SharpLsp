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
    /// `Version` attribute or direct child element value, if present (`None` for
    /// CPM versionless refs, or when two child values are ambiguous).
    pub version: Option<String>,
    /// Whether the element is a single self-closing line carrying only
    /// `Include` / `Version` — i.e. safe to move without losing item metadata
    /// (`PrivateAssets`, `Condition`, child elements, …).
    pub simple: bool,
}

use anyhow::Result;
use quick_xml::{
    encoding::Decoder,
    events::{BytesRef, BytesStart, Event},
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
                    // A non-empty element's subtree is consumed whole, so the
                    // conditions stack stays balanced without its inner events.
                    let child = if empty {
                        ChildVersion::Absent
                    } else {
                        subtree_version(&mut reader)?
                    };
                    items.extend(
                        package_item(&element, empty && !conditional, reader.decoder())?
                            .map(|item| claim_child_version(item, &child)),
                    );
                } else if !empty {
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

/// What a package element's direct `<Version>` children resolve to.
enum ChildVersion {
    /// No direct `<Version>` child at all.
    Absent,
    /// Exactly one unconditional child of pure text, with this decoded value.
    Concrete(String),
    /// Several children, a conditional child, nested markup, or empty text.
    Unresolved,
}

/// Combine a package entry's `Version` attribute with its child resolution. A
/// concrete child value wins because `MSBuild` evaluates child metadata after the
/// attribute (measured with `dotnet msbuild`); an unresolved claim never yields
/// one concrete version to pick silently.
fn claim_child_version(mut item: PackageItem, child: &ChildVersion) -> PackageItem {
    if let ChildVersion::Concrete(value) = child {
        item.version = Some(value.clone());
    } else if matches!(child, ChildVersion::Unresolved) {
        item.version = None;
    }
    item
}

/// Consume one package element's whole subtree, resolving its direct `<Version>`
/// children through XML text events — never string slicing of the source.
fn subtree_version(reader: &mut Reader<&[u8]>) -> Result<ChildVersion> {
    let mut count = 0usize;
    let mut unresolved = false;
    let mut in_child = false;
    let mut child_depth = 0usize;
    let mut depth = 0usize;
    let mut pieces: Vec<String> = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(element) if !in_child && depth == 0 => {
                if element.name().as_ref() == b"Version" {
                    count += 1;
                    unresolved |= count > 1 || element.try_get_attribute("Condition")?.is_some();
                    pieces.clear();
                    in_child = true;
                } else {
                    depth += 1;
                }
            }
            Event::Start(_) if in_child => {
                unresolved = true;
                child_depth += 1;
            }
            Event::Start(_) => depth += 1,
            Event::Empty(element) if !in_child && depth == 0 => {
                if element.name().as_ref() == b"Version" {
                    count += 1;
                    unresolved |= count > 1;
                }
            }
            Event::Empty(_) if in_child => unresolved = true,
            Event::Text(text) if in_child => {
                pieces.push(
                    text.xml_content(quick_xml::XmlVersion::Implicit1_0)?
                        .into_owned(),
                );
            }
            Event::CData(text) if in_child => {
                pieces.push(
                    text.xml_content(quick_xml::XmlVersion::Implicit1_0)?
                        .into_owned(),
                );
            }
            Event::GeneralRef(text) if in_child => match reference_value(&text)? {
                Some(value) => pieces.push(value),
                None => unresolved = true,
            },
            Event::End(_) if in_child && child_depth == 0 => in_child = false,
            Event::End(_) if in_child => child_depth -= 1,
            Event::End(_) if depth == 0 => return Ok(child_version(count, unresolved, &pieces)),
            Event::End(_) => depth -= 1,
            Event::Eof => anyhow::bail!("truncated package element"),
            _ => {}
        }
    }
}

/// The children's resolution: exactly one concrete text value, or unresolved.
fn child_version(count: usize, unresolved: bool, pieces: &[String]) -> ChildVersion {
    match count {
        0 => ChildVersion::Absent,
        _ if unresolved => ChildVersion::Unresolved,
        _ => match pieces.concat().trim() {
            "" => ChildVersion::Unresolved,
            value => ChildVersion::Concrete(value.to_string()),
        },
    }
}

/// Resolve one XML reference name (`amp`, `#46`, `#x2E`) to its text; `None` when
/// the name is not a valid XML 1.0 reference.
fn reference_value(reference: &BytesRef<'_>) -> Result<Option<String>> {
    let name = reference
        .xml_content(quick_xml::XmlVersion::Implicit1_0)?
        .into_owned();
    Ok(match name.strip_prefix('#') {
        Some(digits) => char_reference(digits),
        None => quick_xml::escape::resolve_predefined_entity(&name).map(str::to_string),
    })
}

/// The character of a decimal or hexadecimal character-reference body.
fn char_reference(digits: &str) -> Option<String> {
    let code = digits.strip_prefix(['x', 'X']).map_or_else(
        || digits.parse::<u32>().ok(),
        |hex| u32::from_str_radix(hex, 16).ok(),
    );
    char::from_u32(code?).map(|character| character.to_string())
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

    #[test]
    fn child_version_metadata_fills_the_version_and_blocks_simplicity() {
        let items = read_package_items(
            r#"<Project><ItemGroup>
  <PackageReference Include="Legacy">
    <Version>1.0.0</Version>
  </PackageReference>
</ItemGroup></Project>"#,
            "PackageReference",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].version.as_deref(), Some("1.0.0"));
        assert!(
            !items[0].simple,
            "child metadata must keep the entry ineligible for consolidation"
        );
    }

    #[test]
    fn a_concrete_child_version_wins_over_the_attribute_like_msbuild() {
        // Measured with `dotnet msbuild`: attribute 1.0.0 + child 2.0.0 evaluates
        // to 2.0.0, because child metadata is applied after the attribute.
        let items = read_package_items(
            r#"<Project><PackageVersion Include="Dup" Version="1.0.0"><Version>2.0.0</Version></PackageVersion></Project>"#,
            "PackageVersion",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].version.as_deref(), Some("2.0.0"));
    }

    #[test]
    fn any_number_of_version_children_stays_ambiguous() {
        for children in [
            "<Version>1.0.0</Version><Version>2.0.0</Version><Version>3.0.0</Version>",
            "<Version></Version><Version>2.0.0</Version>",
            "<Version>1.0.0</Version><Version />",
        ] {
            let items = read_package_items(
                format!(
                    r#"<Project><PackageReference Include="Dup">{children}</PackageReference></Project>"#
                )
                .as_str(),
                "PackageReference",
            );
            assert_eq!(items.len(), 1, "{children}");
            assert_eq!(
                items[0].version, None,
                "never claim one version from {children}"
            );
        }
    }

    #[test]
    fn conditional_version_children_stay_unresolved() {
        let items = read_package_items(
            r#"<Project><PackageReference Include="Cond"><Version Condition="'$(A)' != ''">1.0.0</Version></PackageReference></Project>"#,
            "PackageReference",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].version, None,
            "a conditional value is not one concrete version"
        );
    }

    #[test]
    fn cdata_version_content_decodes_and_comments_never_enter_the_value() {
        let cdata = read_package_items(
            r#"<Project><PackageReference Include="Raw"><Version><![CDATA[1.0.0]]></Version></PackageReference></Project>"#,
            "PackageReference",
        );
        assert_eq!(cdata[0].version.as_deref(), Some("1.0.0"));
        let commented = read_package_items(
            r#"<Project><PackageReference Include="Raw"><Version>1.0<!---->0</Version></PackageReference></Project>"#,
            "PackageReference",
        );
        assert_eq!(
            commented[0].version.as_deref(),
            Some("1.00"),
            "adjacent text around a comment is one XML text value"
        );
    }

    #[test]
    fn markup_inside_a_version_child_is_never_truncated_to_a_concrete_value() {
        let items = read_package_items(
            r#"<Project><PackageReference Include="Bad"><Version>1.0<HintPath />0</Version></PackageReference><PackageReference Include="Deep"><HintPath><Version>9.9.9</Version></HintPath></PackageReference></Project>"#,
            "PackageReference",
        );
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0].version, None,
            "markup inside the child blocks the whole value"
        );
        assert_eq!(
            items[1].version, None,
            "a Version nested inside another child is not a direct value"
        );
    }

    #[test]
    fn child_version_entities_decode_through_the_parser() {
        let items = read_package_items(
            r#"<Project><PackageReference Include="Refs"><Version>1.0&#46;0</Version></PackageReference></Project>"#,
            "PackageReference",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].version.as_deref(), Some("1.0.0"));
    }
}
