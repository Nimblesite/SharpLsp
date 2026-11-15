//! Positioned `MSBuild` package items — where a `<PackageReference>` /
//! `<PackageVersion>` element *is*, so diagnostics can be anchored on the
//! declaring element instead of line 1. Implements [PKG-VULN-DIAG].
//!
//! Read-only like [`super::parse`]; mutation still goes through the C# sidecar's
//! `MSBuild` document model. Positions are computed from the XML parser's byte
//! offsets (never source-text slicing), in LSP `UTF-16` character units.

use anyhow::Result;
use lsp_types::{Position, Range};
use quick_xml::{events::Event, Reader};

/// A package item with the range of its declaring element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchoredItem {
    /// Package id (the `Include` attribute value).
    pub id: String,
    /// The `Version` attribute value when present (`None` for CPM versionless
    /// references and child-element versions).
    pub version: Option<String>,
    /// The element's full range: `<` through the closing `>` (child metadata of
    /// a non-empty element included).
    pub range: Range,
}

/// Every `<{tag}>` element with an `Include` attribute and its range.
///
/// `tag` is `"PackageReference"` or `"PackageVersion"`. Attributes decode
/// through the XML parser (entities, both quote styles); comments never
/// produce items.
pub fn read_anchored_items(text: &str, tag: &str) -> Vec<AnchoredItem> {
    read(text, tag).unwrap_or_else(|error| {
        tracing::warn!(%error, "Invalid MSBuild package XML");
        Vec::new()
    })
}

/// Walk the document with the real XML parser, keeping byte offsets per element.
fn read(text: &str, tag: &str) -> Result<Vec<AnchoredItem>> {
    let mut reader = Reader::from_str(text);
    let mut items = Vec::new();
    loop {
        let start = usize::try_from(reader.buffer_position()).unwrap_or(0);
        let event = reader.read_event()?;
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element)
                if element.name().as_ref() == tag.as_bytes() =>
            {
                let id = super::parse::attribute_value(&element, "Include", reader.decoder())?;
                if let Some(id) = id {
                    let version =
                        super::parse::attribute_value(&element, "Version", reader.decoder())?;
                    // A non-empty element's range covers its whole subtree.
                    let end = if empty {
                        usize::try_from(reader.buffer_position()).unwrap_or(start)
                    } else {
                        skip_subtree(&mut reader)?
                    };
                    items.push(AnchoredItem {
                        id,
                        version,
                        range: Range::new(position(text, start), position(text, end)),
                    });
                }
            }
            Event::Eof => return Ok(items),
            _ => {}
        }
    }
}

/// Consume one element's subtree through the parser; returns the byte offset
/// just past its closing tag.
fn skip_subtree(reader: &mut Reader<&[u8]>) -> Result<usize> {
    let mut depth = 0usize;
    loop {
        match reader.read_event()? {
            Event::Start(_) => depth += 1,
            Event::End(_) if depth == 0 => {
                return Ok(usize::try_from(reader.buffer_position()).unwrap_or(0));
            }
            Event::End(_) => depth -= 1,
            Event::Eof => anyhow::bail!("truncated package element"),
            _ => {}
        }
    }
}

/// A byte offset as an LSP position: `UTF-16` character units on its line.
fn position(text: &str, offset: usize) -> Position {
    let offset = offset.min(text.len());
    let mut line = 0u32;
    let mut line_start = 0usize;
    for (index, byte) in text
        .as_bytes()
        .get(..offset)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if *byte == b'\n' {
            line += 1;
            line_start = index + 1;
        }
    }
    let units = text
        .get(line_start..offset)
        .map_or(0usize, |slice| slice.chars().map(char::len_utf16).sum());
    Position::new(line, u32::try_from(units).unwrap_or(u32::MAX))
}

#[cfg(test)]
#[expect(clippy::indexing_slicing, reason = "test fixtures index items")]
mod tests {
    use super::*;

    const FSPROJ: &str = "<Project Sdk=\"Microsoft.NET.Sdk\">\n  <ItemGroup>\n    <Compile Include=\"Library.fs\" />\n    <PackageReference Include=\"Serilog\" Version=\"3.1.0\" />\n  </ItemGroup>\n</Project>\n";

    #[test]
    fn anchors_the_declaring_element_with_start_and_end() {
        let items = read_anchored_items(FSPROJ, "PackageReference");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "Serilog");
        // Line 3 (0-based), column 4: exactly the `<PackageReference …/>` element.
        assert_eq!(items[0].range.start, Position::new(3, 4));
        assert_eq!(items[0].range.end, Position::new(3, 58));
    }

    #[test]
    fn a_non_empty_element_spans_its_subtree() {
        let items = read_anchored_items(
            "<Project><ItemGroup><PackageReference Include=\"Legacy\">\n  <Version>1.0.0</Version>\n</PackageReference></ItemGroup></Project>",
            "PackageReference",
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].range.start, Position::new(0, 20));
        // Ends after the closing tag, not at the start tag.
        assert_eq!(items[0].range.end, Position::new(2, 19));
    }

    #[test]
    fn ignores_comments_and_other_elements() {
        let commented = "<Project><!-- <PackageReference Include=\"Ghost\" /> -->\n<PackageVersion Include=\"Real\" Version=\"1.0.0\" /></Project>";
        assert!(matches!(
            read_anchored_items(commented, "PackageReference").as_slice(),
            []
        ));
        let versions = read_anchored_items(commented, "PackageVersion");
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].id, "Real");
        assert_eq!(versions[0].range.start, Position::new(1, 0));
    }

    /// `UTF-16` character units: one emoji before the element counts as two
    /// columns, one `é` as one — never as `UTF-8` bytes.
    #[test]
    fn positions_count_utf16_units_not_bytes() {
        let items = read_anchored_items(
            "<Project>\n  <!-- \u{1F680} ok -->\n  <PackageReference Include=\"P\" />\n</Project>",
            "PackageReference",
        );
        assert_eq!(items[0].range.start, Position::new(2, 2));
    }

    #[test]
    fn malformed_xml_yields_no_items() {
        assert!(matches!(
            read_anchored_items("<Project><PackageReference", "PackageReference").as_slice(),
            []
        ));
    }

    #[test]
    fn duplicate_ids_are_all_anchored() {
        let items = read_anchored_items(
            "<Project><ItemGroup><PackageReference Include=\"A\" /><PackageReference Include=\"A\" Version=\"2.0.0\" /></ItemGroup></Project>",
            "PackageReference",
        );
        assert_eq!(items.len(), 2);
        assert_ne!(items[0].range, items[1].range);
    }
}
