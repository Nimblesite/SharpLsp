//! Unit tests of the host's one path module. Implements [SHARPLSP-ARCHITECTURE-PATHS].
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
