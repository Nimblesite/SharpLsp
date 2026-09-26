//! The host's one path module: every conversion between a `file://` URI and a
//! native path, and every comparison or normalisation of a native path string.
//! Nothing outside this module converts, compares or normalises a path string.
//! Implements [SHARPLSP-ARCHITECTURE-PATHS].

use std::borrow::Cow;
use std::path::{Path, PathBuf};

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
    if cfg!(windows) {
        comparison_key(left) == comparison_key(right)
    } else {
        strip_verbatim(left) == strip_verbatim(right)
    }
}

/// `text` folded the one way the host folds a path: [`ntfs_upcase`] per character.
/// [SHARPLSP-ARCHITECTURE-PATHS] (GitHub #171)
fn fold(text: &str) -> String {
    text.chars().map(ntfs_upcase).collect()
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
    if cfg!(windows) {
        comparison_key(&canonical)
    } else {
        slashed(&strip_verbatim(&canonical))
    }
}

/// The extension of `path` without its dot, through the one path [`fold`]
/// (upper case); `None` when it has none. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn extension_key(path: impl AsRef<Path>) -> Option<String> {
    path.as_ref()
        .extension()
        .and_then(|extension| extension.to_str())
        .map(fold)
}

/// Whether `path` ends in one of `extensions` (no dot), in any casing: Windows
/// filesystems are case-insensitive, so `Program.CS` is a C# file.
/// [SHARPLSP-ARCHITECTURE-PATHS]
pub fn has_extension(path: impl AsRef<Path>, extensions: &[&str]) -> bool {
    extension_key(path).is_some_and(|key| extensions.iter().any(|wanted| fold(wanted) == key))
}

/// Whether `marker`, an extension written with its dot (`.csproj`), is one of
/// `extensions` (no dot), in any casing. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn is_extension(marker: &str, extensions: &[&str]) -> bool {
    marker.strip_prefix('.').is_some_and(|extension| {
        extensions
            .iter()
            .any(|wanted| fold(wanted) == fold(extension))
    })
}

/// The last segment of `path`, when it is valid UTF-8. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn file_name_of(path: &Path) -> Option<&str> {
    path.file_name().and_then(|name| name.to_str())
}

/// The last segment of `path` without its extension. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn file_stem_of(path: impl AsRef<Path>) -> Option<String> {
    path.as_ref()
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
}

/// Whether the last segment of `path` is `name`, in any casing. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn has_file_name(path: impl AsRef<Path>, name: &str) -> bool {
    file_name_of(path.as_ref()).is_some_and(|actual| fold(actual) == fold(name))
}

/// Whether the last segment of `path` ends in `suffix`, in any casing: a
/// multi-dot suffix such as `.runtimeconfig.json`. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn has_name_suffix(path: impl AsRef<Path>, suffix: &str) -> bool {
    file_name_of(path.as_ref()).is_some_and(|name| fold(name).ends_with(&fold(suffix)))
}

/// The directory holding `path`; `None` for a root or a bare file name.
/// [SHARPLSP-ARCHITECTURE-PATHS]
pub fn directory_of(path: impl AsRef<Path>) -> Option<PathBuf> {
    path.as_ref()
        .parent()
        .filter(|directory| !directory.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

/// `path` relative to `root`, when it lies beneath it. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn relative_to(path: &Path, root: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|relative| relative.to_string_lossy().into_owned())
}

/// `path` spelled with forward slashes. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn slashed(path: &str) -> String {
    path.replace('\\', "/")
}

/// The one key two spellings of a path compare by: no verbatim prefix, forward
/// slashes, and the one path [`fold`], the NTFS upcase the VFS identity uses
/// (GitHub #171). The only case fold on a path in the host.
/// [SHARPLSP-ARCHITECTURE-PATHS]
pub fn comparison_key(path: &str) -> String {
    fold(&slashed(&strip_verbatim(path)))
}

/// The canonical `PathBuf` of an existing `path`, as a visited-set key. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn canonical_buf(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The file name of the `stem` executable on this platform. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn executable_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// The spellings a command resolves to on `PATH`: Windows adds its executable
/// suffixes. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn command_file_names(command: &str) -> Vec<String> {
    let suffixes: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    suffixes
        .iter()
        .map(|suffix| format!("{command}{suffix}"))
        .collect()
}

/// Whether `path` names the `stem` executable (`dotnet`, `dotnet.exe`), in any
/// casing. [SHARPLSP-ARCHITECTURE-PATHS]
pub fn names_executable(path: &str, stem: &str) -> bool {
    let name = fold(file_name_of(Path::new(path)).unwrap_or(path));
    name == fold(stem) || name == fold(&format!("{stem}.exe"))
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
#[path = "paths_tests.rs"]
mod tests;
