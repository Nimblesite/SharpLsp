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
    let parsed_uri = path_to_lsp_uri(&item.file_path).ok()?;
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
    let mut parsed = Url::parse(uri).with_context(|| format!("parse file URI: {uri}"))?;
    if parsed.scheme() != "file" {
        anyhow::bail!("expected a file:// URI, got scheme {:?}", parsed.scheme());
    }
    normalize_bare_drive_root(&mut parsed);
    match parsed.to_file_path() {
        Ok(path) => path.into_os_string().into_string().map_err(|lossy| {
            anyhow::anyhow!("file path is not valid UTF-8: {}", lossy.to_string_lossy())
        }),
        Err(()) => decoded_posix_path(&parsed),
    }
}

/// Repair a drive-root URI that omits the trailing slash (`file:///c:` or
/// `file:///c%3A`), a form some clients build by string concatenation. Without
/// the slash the url crate's `to_file_path` trips a debug assertion (aborting
/// the request thread in dev builds) and yields a drive-RELATIVE path (`c:`)
/// in release — whose meaning depends on the process's per-drive current
/// directory. Appending the root slash maps it to the drive root. [GitHub #110]
fn normalize_bare_drive_root(parsed: &mut Url) {
    let path = parsed.path();
    let is_bare_drive = match path.as_bytes() {
        [b'/', drive, b':'] | [b'/', drive, b'%', b'3', b'a' | b'A'] => drive.is_ascii_alphabetic(),
        _ => false,
    };
    if is_bare_drive {
        let rooted = format!("{path}/");
        parsed.set_path(&rooted);
    }
}

/// Degraded conversion for `file://` URIs with no native path representation
/// (e.g. `file:///test/f.fs` on Windows, which has no drive letter). Such URIs
/// are still valid LSP document URIs, so a request naming one must not fail —
/// downstream consumers treat the resulting nonexistent path as "no semantic
/// result". Returns the percent-decoded POSIX-style URI path.
fn decoded_posix_path(parsed: &Url) -> Result<String> {
    percent_encoding::percent_decode_str(parsed.path())
        .decode_utf8()
        .map(std::borrow::Cow::into_owned)
        .with_context(|| format!("file URI path is not valid UTF-8: {parsed}"))
}

/// Convert a native filesystem path to a `file://` URI string.
///
/// Inverse of [`uri_to_path`], via the same RFC 8089 builder. A native Windows
/// path becomes a valid URI: `C:\dir\f.cs` → `file:///C:/dir/f.cs` (forward
/// slashes, drive preserved, special characters percent-encoded), not
/// `file://C:\dir\f.cs`. The naive form fails to parse, so every sidecar-returned
/// navigation location (definition, references, rename, hierarchy) is silently
/// dropped on Windows and the request falls through to a null result. Requires an
/// absolute path, which sidecar file paths always are. Implements the correct
/// conversion for [GitHub #110].
pub fn path_to_uri(path: &str) -> Result<String> {
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|()| anyhow::anyhow!("cannot form a file URI from a non-absolute path: {path}"))
}

/// Convert a native filesystem path to an LSP [`Uri`], via [`path_to_uri`].
/// Single shared conversion for every module that maps sidecar file paths
/// into client-facing URIs (locations, workspace edits, diagnostics).
pub fn path_to_lsp_uri(path: &str) -> Result<Uri> {
    path_to_uri(path)?
        .parse()
        .map_err(|err| anyhow::anyhow!("parse file URI for {path}: {err}"))
}

/// Windows `CREATE_NO_WINDOW` process-creation flag. Without it, every child
/// process (sidecars, dotnet invocations, profiler tools) flashes a console
/// window when the host itself runs without one (i.e. launched by an editor).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the child's console window on Windows. No-op elsewhere.
pub fn hide_console_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Suppress the child's console window on Windows. No-op elsewhere.
pub fn hide_console_window_tokio(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        let _ = command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// Safely convert `usize` to `u32`, clamping to `u32::MAX` on overflow.
pub fn usize_to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Test-only fixtures shared by unit tests across modules that map between
/// native paths and `file://` URIs. Each OS produces a different absolute-path
/// shape (`C:\...` vs `/...`), and #110 shipped precisely because tests only
/// exercised the Unix shape — so tests must use the platform's real one.
#[cfg(test)]
pub mod test_paths {
    /// A platform-native absolute file path, as a sidecar would return it.
    pub const NATIVE_FILE: &str = if cfg!(windows) {
        r"C:\tmp\Foo.cs"
    } else {
        "/tmp/Foo.cs"
    };
    /// The exact `file://` URI for [`NATIVE_FILE`].
    pub const NATIVE_FILE_URI: &str = if cfg!(windows) {
        "file:///C:/tmp/Foo.cs"
    } else {
        "file:///tmp/Foo.cs"
    };
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

    /// A rooted `file://` URI without a drive letter (`file:///test/f.fs`) has
    /// no native Windows representation, but it is still a valid LSP document
    /// URI (in-memory test documents, non-local files). It must degrade to the
    /// percent-decoded POSIX-style path — downstream consumers treat the
    /// nonexistent path as "no semantic result" — never fail the request.
    #[cfg(windows)]
    #[test]
    fn uri_to_path_degrades_driveless_uris_to_posix_paths() {
        assert_eq!(
            uri_to_path("file:///test/Library.fs").unwrap(),
            "/test/Library.fs"
        );
        assert_eq!(
            uri_to_path("file:///test/My%20Lib/App.fs").unwrap(),
            "/test/My Lib/App.fs"
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

    /// GitHub #110 (reverse direction): sidecar responses carry native Windows
    /// paths (`C:\dir\f.cs`). They must become valid `file:///C:/dir/f.cs` URIs
    /// or the client drops the location — go-to-definition, references, rename,
    /// and hierarchy silently return null on Windows. The naive
    /// `format!("file://{path}")` yields `file://C:\dir\f.cs`, which is not a
    /// parseable URI.
    #[cfg(windows)]
    #[test]
    fn path_to_uri_yields_valid_windows_file_uris() {
        assert_eq!(
            path_to_uri(r"C:\Users\test\Program.cs").unwrap(),
            "file:///C:/Users/test/Program.cs"
        );
        // Spaces must be percent-encoded to form a valid URI.
        assert_eq!(
            path_to_uri(r"C:\My Code\App.fs").unwrap(),
            "file:///C:/My%20Code/App.fs"
        );
        // Relative paths cannot form file URIs and must be rejected, not mangled.
        assert!(path_to_uri(r"relative\App.fs").is_err());
    }

    /// On Unix the reverse conversion produces standard `file:///abs/path` URIs.
    #[cfg(unix)]
    #[test]
    fn path_to_uri_yields_valid_unix_file_uris() {
        assert_eq!(
            path_to_uri("/home/user/proj/Program.cs").unwrap(),
            "file:///home/user/proj/Program.cs"
        );
        assert_eq!(
            path_to_uri("/home/user/My Proj/App.fs").unwrap(),
            "file:///home/user/My%20Proj/App.fs"
        );
        assert!(path_to_uri("relative/App.fs").is_err());
    }

    /// Round-trip: a native path converted to a URI and back must be unchanged.
    /// This is the invariant #110 depends on — the client sends URIs, the
    /// sidecar speaks native paths, and every hop between them must be lossless.
    #[test]
    fn path_uri_round_trip_is_lossless() {
        let native = if cfg!(windows) {
            r"C:\Users\test\My Code\Program.cs"
        } else {
            "/home/user/My Code/Program.cs"
        };
        let uri = path_to_uri(native).unwrap();
        assert_eq!(uri_to_path(&uri).unwrap(), native);
    }

    /// Some clients build workspace-folder URIs by concatenation and omit the
    /// root slash (`file:///c:` instead of `file:///c:/`). The url crate
    /// panics on these under debug assertions and yields a drive-RELATIVE
    /// path (`c:`) in release — both catastrophic for a client-controlled
    /// input. [GitHub #110]
    #[cfg(windows)]
    #[test]
    fn uri_to_path_maps_bare_drive_root_uris_to_the_drive_root() {
        assert_eq!(uri_to_path("file:///c:").unwrap(), r"c:\");
        assert_eq!(uri_to_path("file:///c%3A").unwrap(), r"c:\");
        assert_eq!(uri_to_path("file:///C%3a").unwrap(), r"C:\");
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
