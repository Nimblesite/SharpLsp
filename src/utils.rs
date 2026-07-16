//! Shared utility functions used across multiple modules.

use anyhow::{Context, Result};
use lsp_types::{Position, Range, TextEdit, Uri};
use url::Url;

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

/// Request identifying a position in a file, sent to a sidecar. Serialized as a
/// positional `MessagePack` array `(file_path, line, character)` matching the
/// sidecars' `PositionRequest` Key layout.
#[derive(serde::Serialize)]
pub struct SidecarPositionReq {
    /// Absolute path to the source file.
    pub file_path: String,
    /// Zero-based line number.
    pub line: u32,
    /// Zero-based character offset within the line.
    pub character: u32,
}

/// Request identifying a whole file, sent to a sidecar. Serialized as a
/// positional `MessagePack` array `(file_path)` matching the sidecars'
/// `FileRequest` Key layout.
#[derive(serde::Serialize)]
pub struct SidecarFileReq {
    /// Absolute path to the source file.
    pub file_path: String,
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

/// Convert a `file://` URI string to a native filesystem path string.
///
/// Parses the URI (RFC 8089) rather than trimming the scheme, so Windows drive
/// letters and percent-encoding are handled correctly: `file:///C:/dir/f.cs` and
/// VS Code's percent-encoded `file:///c%3A/dir/f.cs` both become `C:\dir\f.cs`,
/// not `/C:/dir/f.cs`. A naive `strip_prefix("file://")` leaves the leading slash
/// and the raw `%3A`, producing a path Roslyn/FCS cannot resolve — so every
/// semantic feature returns nothing on Windows even once the sidecar transport is
/// up. Implements the correct conversion for [GitHub #110].
pub fn uri_to_path(uri: &str) -> Result<String> {
    let parsed = Url::parse(uri).with_context(|| format!("parse file URI: {uri}"))?;
    if parsed.scheme() != "file" {
        anyhow::bail!("expected a file:// URI, got scheme {:?}", parsed.scheme());
    }
    parsed
        .to_file_path()
        .map_err(|()| anyhow::anyhow!("file URI is not a valid filesystem path: {uri}"))?
        .into_os_string()
        .into_string()
        .map_err(|lossy| {
            anyhow::anyhow!("file path is not valid UTF-8: {}", lossy.to_string_lossy())
        })
}

/// Safely convert `usize` to `u32`, clamping to `u32::MAX` on overflow.
pub fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

#[cfg(test)]
#[cfg_attr(
    windows,
    expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )
)]
#[cfg_attr(
    unix,
    expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )
)]
mod tests {
    use super::*;

    /// GitHub #110: a real VS Code file URI on Windows carries a drive letter and
    /// often percent-encodes the drive colon (`%3A`) and spaces (`%20`). It must
    /// convert to the native path the sidecar can actually open. A naive
    /// `strip_prefix("file://")` leaves a leading slash and the raw `%3A`,
    /// yielding `/e%3A/Pavo/Systems/Terrain.fs` — a path Roslyn/FCS cannot
    /// resolve, so every semantic feature returns nothing on Windows even once
    /// the sidecar transport is up ("no symbol support beyond colorization").
    #[cfg(windows)]
    #[test]
    fn uri_to_path_yields_native_windows_paths() {
        assert_eq!(
            uri_to_path("file:///C:/Users/test/Program.cs").unwrap(),
            r"C:\Users\test\Program.cs"
        );
        // Exact path from the #110 report, as VS Code percent-encodes it.
        assert_eq!(
            uri_to_path("file:///e%3A/Pavo/Systems/Terrain.fs").unwrap(),
            r"e:\Pavo\Systems\Terrain.fs"
        );
        // Percent-encoded spaces must decode to real spaces.
        assert_eq!(
            uri_to_path("file:///C:/My%20Code/App.fs").unwrap(),
            r"C:\My Code\App.fs"
        );
    }

    /// On Unix the same conversion keeps absolute POSIX paths intact and decodes
    /// percent-encoding.
    #[cfg(unix)]
    #[test]
    fn uri_to_path_yields_native_unix_paths() {
        assert_eq!(
            uri_to_path("file:///home/user/proj/Program.cs").unwrap(),
            "/home/user/proj/Program.cs"
        );
        assert_eq!(
            uri_to_path("file:///home/user/My%20Proj/App.fs").unwrap(),
            "/home/user/My Proj/App.fs"
        );
    }

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
