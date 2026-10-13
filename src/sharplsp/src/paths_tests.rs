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

#[cfg(windows)]
#[test]
fn command_file_names_only_offers_spawnable_exe_on_windows() {
    // CreateProcess cannot launch `.cmd`/`.bat` shims or extensionless files,
    // so PATH resolution must not accept them. [GitHub #167]
    assert_eq!(command_file_names("dotnet"), vec!["dotnet.exe".to_string()]);
}

#[cfg(not(windows))]
#[test]
fn command_file_names_is_the_bare_name_off_windows() {
    assert_eq!(command_file_names("dotnet"), vec!["dotnet".to_string()]);
}

/// The empty file `name` in `dir`, as a `PATH` entry would hold it.
fn touch(dir: &Path, name: &str) -> PathBuf {
    let file = dir.join(name);
    std::fs::write(&file, b"").unwrap();
    file
}

/// GitHub #167: `dotnet tool`, npm and script installs leave `.cmd`, `.bat`,
/// `.ps1` and extensionless shims on `PATH`. `CreateProcess` launches none of
/// them, so resolution must skip every one and reach the real `.exe` in a
/// later `PATH` entry, or resolve nothing. [SIDECAR-STARTUP-RESOLUTION]
#[cfg(windows)]
#[test]
fn find_command_skips_every_windows_shim_and_takes_the_exe() {
    let shims = tempfile::tempdir().unwrap();
    let real = tempfile::tempdir().unwrap();
    let shim_files: Vec<PathBuf> = ["", ".cmd", ".bat", ".ps1"]
        .iter()
        .map(|suffix| touch(shims.path(), &format!("sharplsp-sidecar-csharp{suffix}")))
        .collect();
    assert_eq!(shim_files.len(), 4);
    assert!(shim_files.iter().all(|file| file.is_file()));

    // Only shims on PATH: nothing spawnable, so the caller falls back.
    let only_shims = test_paths::path_var_of(&[shims.path()]).unwrap();
    assert_eq!(find_command("sharplsp-sidecar-csharp", &only_shims), None);
    assert_eq!(find_command("SHARPLSP-SIDECAR-CSHARP", &only_shims), None);

    // A real `.exe` in a later entry wins over the earlier entry's shims.
    let exe = touch(real.path(), "sharplsp-sidecar-csharp.exe");
    let both = test_paths::path_var_of(&[shims.path(), real.path()]).unwrap();
    let found = find_command("sharplsp-sidecar-csharp", &both).unwrap();
    assert_eq!(found, exe);
    assert_eq!(found.parent(), Some(real.path()));
    assert_eq!(found.extension().and_then(|ext| ext.to_str()), Some("exe"));
    assert!(!found.starts_with(shims.path()));

    // An `.exe` beside the shims in the first entry wins on PATH order.
    let first = touch(shims.path(), "sharplsp-sidecar-csharp.exe");
    assert_eq!(find_command("sharplsp-sidecar-csharp", &both), Some(first));
}

/// Off Windows the bare name is the executable; a `.cmd` spelling never is.
#[cfg(not(windows))]
#[test]
fn find_command_takes_the_bare_name_off_windows() {
    let dir = tempfile::tempdir().unwrap();
    let cmd = touch(dir.path(), "sharplsp-sidecar-csharp.cmd");
    let path_var = test_paths::path_var_of(&[dir.path()]).unwrap();
    assert!(cmd.is_file());
    assert_eq!(find_command("sharplsp-sidecar-csharp", &path_var), None);

    let bare = touch(dir.path(), "sharplsp-sidecar-csharp");
    let found = find_command("sharplsp-sidecar-csharp", &path_var).unwrap();
    assert_eq!(found, bare);
    assert_ne!(found, cmd);
    assert_eq!(found.extension(), None);
}

/// A directory spelt like the executable is not one, and an empty `PATH`
/// resolves nothing. [SIDECAR-STARTUP-RESOLUTION]
#[test]
fn find_command_skips_directories_and_empty_path() {
    let decoy = tempfile::tempdir().unwrap();
    let real = tempfile::tempdir().unwrap();
    let exe_name = executable_name("sharplsp-sidecar-fsharp");
    std::fs::create_dir(decoy.path().join(&exe_name)).unwrap();
    assert!(decoy.path().join(&exe_name).is_dir());

    let decoy_only = test_paths::path_var_of(&[decoy.path()]).unwrap();
    assert_eq!(find_command("sharplsp-sidecar-fsharp", &decoy_only), None);
    let empty = std::ffi::OsStr::new("");
    assert_eq!(find_command("sharplsp-sidecar-fsharp", empty), None);

    let exe = touch(real.path(), &exe_name);
    let both = test_paths::path_var_of(&[decoy.path(), real.path()]).unwrap();
    assert_eq!(find_command("sharplsp-sidecar-fsharp", &both), Some(exe));
}

/// Every spelling that is not exactly the platform executable: shims, other
/// launchable-looking suffixes, double suffixes and case variants of them.
const NON_EXECUTABLE_SUFFIXES: [&str; 12] = [
    ".cmd", ".bat", ".ps1", ".com", ".lnk", ".sh", ".dll", ".CMD", ".Bat", ".exe.cmd", ".cmd.txt",
    "-shim",
];

/// GitHub #167, one spelling at a time: a `PATH` entry holding only that
/// spelling resolves nothing, and adding the real executable beside it
/// resolves exactly the executable. [SIDECAR-STARTUP-RESOLUTION]
#[test]
fn find_command_rejects_each_non_executable_spelling_alone() {
    let exe_name = executable_name("sharplsp-sidecar-csharp");
    for suffix in NON_EXECUTABLE_SUFFIXES {
        let dir = tempfile::tempdir().unwrap();
        let decoy = touch(dir.path(), &format!("sharplsp-sidecar-csharp{suffix}"));
        let path_var = test_paths::path_var_of(&[dir.path()]).unwrap();
        assert!(decoy.is_file(), "{suffix}: fixture must exist");
        assert_eq!(
            find_command("sharplsp-sidecar-csharp", &path_var),
            None,
            "{suffix} must not resolve"
        );

        let exe = touch(dir.path(), &exe_name);
        let found = find_command("sharplsp-sidecar-csharp", &path_var);
        assert_eq!(found, Some(exe), "{suffix}: the executable beside it wins");
        assert_ne!(found, Some(decoy), "{suffix} must never be the answer");
    }
}

/// Windows file names are case-insensitive: the `.exe` resolves whatever the
/// casing of the command or of the file on disk. [SIDECAR-STARTUP-RESOLUTION]
#[cfg(windows)]
#[test]
fn find_command_matches_the_exe_in_any_casing_on_windows() {
    for on_disk in ["tool-x.exe", "TOOL-X.EXE", "Tool-X.Exe"] {
        let dir = tempfile::tempdir().unwrap();
        let _file = touch(dir.path(), on_disk);
        let path_var = test_paths::path_var_of(&[dir.path()]).unwrap();
        for command in ["tool-x", "TOOL-X", "Tool-X"] {
            let found = find_command(command, &path_var);
            assert!(found.is_some(), "{command} must resolve {on_disk}");
            let found = found.unwrap();
            assert_eq!(found.parent(), Some(dir.path()), "{command} vs {on_disk}");
            assert!(found.is_file(), "{command} vs {on_disk}");
            assert_eq!(
                found.file_name(),
                Some(OsStr::new(&executable_name(command)))
            );
        }
    }
}

/// Empty, missing and file (not directory) `PATH` entries are skipped, and the
/// search goes on to the entry that holds the executable. [SIDECAR-STARTUP-RESOLUTION]
#[test]
fn find_command_skips_empty_missing_and_file_path_entries() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("not-created");
    let file_entry = touch(root.path(), "a-file-not-a-dir");
    let real = tempfile::tempdir().unwrap();
    let exe = touch(real.path(), &executable_name("sharplsp-sidecar-fsharp"));
    let entries = [
        missing.as_path(),
        Path::new(""),
        file_entry.as_path(),
        real.path(),
    ];
    let path_var = test_paths::path_var_of(&entries).unwrap();

    assert!(!missing.exists());
    assert_eq!(
        find_command("sharplsp-sidecar-fsharp", &path_var),
        Some(exe)
    );
    let without_real = test_paths::path_var_of(&entries[..3]).unwrap();
    assert_eq!(find_command("sharplsp-sidecar-fsharp", &without_real), None);
}

/// Windows `PATH` entries may be quoted and hold spaces; the quotes are not part
/// of the directory. [SIDECAR-STARTUP-RESOLUTION]
#[cfg(windows)]
#[test]
fn find_command_reads_quoted_windows_path_entries() {
    let root = tempfile::tempdir().unwrap();
    let spaced = root.path().join("Program Files (x86)");
    std::fs::create_dir(&spaced).unwrap();
    let exe = touch(&spaced, "sharplsp-sidecar-csharp.exe");
    let quoted = std::ffi::OsString::from(format!("\"{}\"", spaced.display()));

    let found = find_command("sharplsp-sidecar-csharp", &quoted).unwrap();
    assert_eq!(found, exe);
    assert!(found.is_file());
    assert!(!found.to_string_lossy().contains('"'));
}
