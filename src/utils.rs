//! Shared utility functions used across multiple modules.

use anyhow::{Context, Result};
use lsp_types::{Position, Range, TextEdit, Uri};

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

/// A text edit returned by the sidecar in flat-coordinate form. Shared by the
/// formatting, code-action, and completion-resolve flows, which deserialize it
/// and map it into an LSP [`TextEdit`].
#[derive(serde::Deserialize)]
pub struct SidecarTextEdit {
    /// Start line of the range to replace.
    pub start_line: u32,
    /// Start character offset within the start line.
    pub start_character: u32,
    /// End line of the range to replace.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
    /// Replacement text to insert at the range.
    pub new_text: String,
}

/// Convert a sidecar text edit into an LSP [`TextEdit`].
pub fn map_text_edit(edit: &SidecarTextEdit) -> TextEdit {
    TextEdit {
        range: Range::new(
            Position::new(edit.start_line, edit.start_character),
            Position::new(edit.end_line, edit.end_character),
        ),
        new_text: edit.new_text.clone(),
    }
}

/// Convert a slice of sidecar text edits into LSP [`TextEdit`]s.
pub fn map_text_edits(edits: &[SidecarTextEdit]) -> Vec<TextEdit> {
    edits.iter().map(map_text_edit).collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_text_edit_translates_range_and_text() {
        let edit = SidecarTextEdit {
            start_line: 1,
            start_character: 2,
            end_line: 3,
            end_character: 4,
            new_text: "x".to_string(),
        };
        let mapped = map_text_edit(&edit);
        assert_eq!(mapped.range.start, Position::new(1, 2));
        assert_eq!(mapped.range.end, Position::new(3, 4));
        assert_eq!(mapped.new_text, "x");
    }
}
