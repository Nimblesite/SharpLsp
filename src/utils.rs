//! Shared utility functions used across multiple modules.

use anyhow::{Context, Result};
use lsp_types::{Position, Range, Uri};

/// A hierarchy item returned by the sidecar for call- and type-hierarchy
/// requests. Shared by `call_hierarchy` and `type_hierarchy`, which map it
/// into their respective LSP item types.
#[derive(serde::Deserialize)]
pub struct SidecarHierarchyItem {
    /// Display name of the symbol.
    pub name: String,
    /// Symbol kind string (e.g. "Function", "Class").
    pub kind: String,
    /// Absolute path to the file containing this symbol.
    pub file_path: String,
    /// Start line of the symbol range.
    pub line: u32,
    /// Start character offset within the start line.
    pub character: u32,
    /// End line of the symbol range.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
}

/// Compute the LSP location triple `(uri, range, selection_range)` shared by
/// call-hierarchy and type-hierarchy item mapping.
///
/// Returns `None` when the sidecar's file path cannot be parsed into a URI.
pub fn hierarchy_item_location(item: &SidecarHierarchyItem) -> Option<(Uri, Range, Range)> {
    let uri = format!("file://{}", item.file_path);
    let parsed_uri = uri.parse::<Uri>().ok()?;
    let range = Range::new(
        Position::new(item.line, item.character),
        Position::new(item.end_line, item.end_character),
    );
    let selection_range = Range::new(
        Position::new(item.line, item.character),
        Position::new(item.line, item.character),
    );
    Some((parsed_uri, range, selection_range))
}

/// Convert a `file://` URI string to a filesystem path string.
pub fn uri_to_path(uri: &str) -> Result<String> {
    uri.strip_prefix("file://")
        .map(String::from)
        .context("expected file:// URI")
}

/// Safely convert `usize` to `u32`, clamping to `u32::MAX` on overflow.
pub fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
