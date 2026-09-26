//! The host's one path module: every conversion between a `file://` URI and a
//! native path, and every comparison or normalisation of a native path string.
//! Nothing outside this module converts, compares or normalises a path string.
//! Implements [SHARPLSP-ARCHITECTURE-PATHS].

use std::borrow::Cow;

use anyhow::{Context, Result};
use lsp_types::Uri;
use url::Url;

/// Convert a `file://` URI string to a native filesystem path string.
///
/// Parses the URI (RFC 8089) rather than trimming the scheme, so Windows drive
/// letters and percent-encoding are handled correctly: `file:///C:/dir/f.cs` and
/// VS Code's percent-encoded `file:///c%3A/dir/f.cs` both become `C:\dir\f.cs`,
/// not `/C:/dir/f.cs`. A naive `strip_prefix("file://")` leaves the leading slash
/// and the raw `%3A`, producing a path Roslyn/FCS cannot resolve — so every
/// semantic feature returns nothing on Windows even once the sidecar transport is
/// up. Implements the correct conversion for [GitHub #110] and
/// [SHARPLSP-ARCHITECTURE-PATHS].
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
/// [SHARPLSP-ARCHITECTURE-PATHS]
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
/// [SHARPLSP-ARCHITECTURE-PATHS]
fn decoded_posix_path(parsed: &Url) -> Result<String> {
    percent_encoding::percent_decode_str(parsed.path())
        .decode_utf8()
        .map(Cow::into_owned)
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
/// conversion for [GitHub #110] and [SHARPLSP-ARCHITECTURE-PATHS].
pub fn path_to_uri(path: &str) -> Result<String> {
    Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|()| anyhow::anyhow!("cannot form a file URI from a non-absolute path: {path}"))
}

/// Convert a native filesystem path to an LSP [`Uri`], via [`path_to_uri`].
/// Single shared conversion for every module that maps sidecar file paths
/// into client-facing URIs (locations, workspace edits, diagnostics).
/// [SHARPLSP-ARCHITECTURE-PATHS]
pub fn path_to_lsp_uri(path: &str) -> Result<Uri> {
    path_to_uri(path)?
        .parse()
        .map_err(|err| anyhow::anyhow!("parse file URI for {path}: {err}"))
}

/// Resolve a native path to the canonical spelling of the file it names, when the
/// file exists on disk. The verbatim prefix `std::fs::canonicalize` adds is
/// stripped up front so the result compares directly against the plain paths
/// editors and sidecars supply. Implements [SE-LIVE-BUFFER] (GitHub #191) and
/// [SHARPLSP-ARCHITECTURE-PATHS].
pub fn canonical_path(path: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    Some(strip_verbatim(&canonical.to_string_lossy()).into_owned())
}

/// Resolve a document URI to the canonical spelling of its native path, when the
/// file exists on disk, via [`canonical_path`]. Implements [SE-LIVE-BUFFER]
/// (GitHub #191) and [SHARPLSP-ARCHITECTURE-PATHS].
pub fn canonical_native_path(uri: &Uri) -> Option<String> {
    canonical_path(&uri_to_path(uri.as_str()).ok()?)
}

/// Compare two native paths for equality. Windows verbatim (`\\?\`) prefixes
/// are ignored and the comparison is case-insensitive on Windows, where the
/// filesystem is too: editors lowercase the drive letter (`c:`) while
/// `std::fs::canonicalize` uppercases it (`\\?\C:`). NTFS ignores case across
/// Unicode, not only ASCII, so the fold is [`ntfs_upcase`] (GitHub #171).
/// [SHARPLSP-ARCHITECTURE-PATHS]
pub fn native_paths_equal(left: &str, right: &str) -> bool {
    let (left, right) = (strip_verbatim(left), strip_verbatim(right));
    if cfg!(windows) {
        left.chars()
            .map(ntfs_upcase)
            .eq(right.chars().map(ntfs_upcase))
    } else {
        left == right
    }
}

/// One character upcased the way NTFS's `$UpCase` table upcases it: one UTF-16
/// unit to one. A character whose uppercase is a single character in the Basic
/// Multilingual Plane becomes it (`ä` → `Ä`, `σ` → `Σ`); any other stays itself
/// — `ß`, whose uppercase is the two characters `SS`, and anything outside the
/// BMP, which a table of UTF-16 units never maps. This approximates the
/// volume's own table, which the OS fixes when it formats the volume.
/// [SHARPLSP-ARCHITECTURE-PATHS]
fn ntfs_upcase(character: char) -> char {
    let mut upper = character.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(single), None) if character.len_utf16() == 1 && single.len_utf16() == 1 => single,
        _ => character,
    }
}

/// Strip the Windows verbatim prefix `std::fs::canonicalize` adds:
/// `\\?\C:\...` becomes `C:\...` and `\\?\UNC\server\share\...` becomes
/// `\\server\share\...`. A bare `\\?\` strip would leave the UNC form as
/// `UNC\server\share\...`, which can never equal the plain spelling — so
/// every network-share document would miss the VFS. [GitHub #110]
/// [SHARPLSP-ARCHITECTURE-PATHS]
fn strip_verbatim(path: &str) -> Cow<'_, str> {
    if let Some(unc_rest) = path.strip_prefix(r"\\?\UNC\") {
        return Cow::Owned(format!(r"\\{unc_rest}"));
    }
    Cow::Borrowed(path.strip_prefix(r"\\?\").unwrap_or(path))
}

/// Canonicalize a path into a stable cross-sidecar merge key: the canonical
/// spelling when the file exists, without the verbatim prefix, with forward
/// slashes, and case-folded on Windows. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn normalized_rename_path(path: &str) -> String {
    let canonical = canonical_path(path).unwrap_or_else(|| path.to_string());
    let normalized = strip_verbatim(&canonical).replace('\\', "/");
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
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
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )]

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
    fn uri_to_path_converts_to_native_path() {
        // `uri_to_path` yields a NATIVE path per platform: a driveless POSIX URI
        // is a valid path only on Unix, while Windows requires a drive letter
        // (GitHub #110 — `file:///C:/…` must not become `/C:/…`).
        #[cfg(unix)]
        {
            let path = uri_to_path("file:///home/user/test.cs").unwrap();
            assert_eq!(path, "/home/user/test.cs");
        }
        #[cfg(windows)]
        {
            let path = uri_to_path("file:///C:/Users/test.cs").unwrap();
            assert_eq!(path, r"C:\Users\test.cs");
        }
    }

    #[test]
    fn uri_to_path_rejects_non_file() {
        assert!(uri_to_path("https://example.com").is_err());
    }

    #[test]
    fn path_to_uri_valid_path() {
        use super::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
        let uri = path_to_lsp_uri(NATIVE_FILE).unwrap();
        assert_eq!(uri.as_str(), NATIVE_FILE_URI);
    }

    #[cfg(windows)]
    #[test]
    fn native_paths_equal_strips_verbatim_disk_and_unc_prefixes() {
        // `std::fs::canonicalize` returns `\\?\C:\...` for local paths and
        // `\\?\UNC\server\share\...` for network paths; both must compare
        // equal to their plain spellings. [GitHub #110]
        assert!(native_paths_equal(r"\\?\C:\dir\F.cs", r"c:\dir\f.cs"));
        assert!(
            native_paths_equal(r"\\?\UNC\server\share\F.cs", r"\\server\share\f.cs"),
            "verbatim UNC must equal its plain UNC spelling"
        );
        assert!(!native_paths_equal(
            r"\\?\UNC\server\share\F.cs",
            r"\\other\share\F.cs"
        ));
    }
}
