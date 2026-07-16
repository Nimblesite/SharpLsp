//! Virtual File System — authoritative document state for open files.

use dashmap::DashMap;
use lsp_types::Uri;

/// Stores the current content of all open documents.
pub struct Vfs {
    /// Concurrent map of open document URIs to their state.
    documents: DashMap<Uri, DocumentState>,
}

/// State of a single open document tracked by the VFS.
pub struct DocumentState {
    /// Full text content of the document.
    pub content: String,
    /// LSP document version counter.
    pub version: i32,
}

impl Vfs {
    /// Create an empty VFS.
    pub fn new() -> Self {
        Self {
            documents: DashMap::new(),
        }
    }

    /// Open a document (textDocument/didOpen).
    pub fn open(&self, uri: Uri, version: i32, text: String) {
        let _ = self.documents.insert(
            uri,
            DocumentState {
                content: text,
                version,
            },
        );
    }

    /// Apply a full-content change (textDocument/didChange with full sync).
    pub fn change(&self, uri: &Uri, version: i32, text: String) {
        if let Some(mut doc) = self.documents.get_mut(uri) {
            doc.content = text;
            doc.version = version;
        }
    }

    /// Close a document (textDocument/didClose).
    pub fn close(&self, uri: &Uri) {
        let _ = self.documents.remove(uri);
    }

    /// Get the current content of a document.
    pub fn get_content(&self, uri: &Uri) -> Option<String> {
        self.documents.get(uri).map(|d| d.content.clone())
    }

    /// Get the content of an open document identified by its native
    /// filesystem path, regardless of how the editor encoded its URI.
    ///
    /// Editors encode the same file differently — VS Code sends
    /// `file:///c%3A/dir%20name/f.cs` where an RFC 8089 builder produces
    /// `file:///C:/dir%20name/f.cs` — so rebuilding a URI from a path and
    /// matching it as a string misses open documents. Instead each stored
    /// URI is normalized to a native path and the paths are compared.
    /// [GitHub #110]
    pub fn get_content_for_path(&self, path: &str) -> Option<String> {
        self.documents.iter().find_map(|entry| {
            let doc_path = crate::utils::uri_to_path(entry.key().as_str()).ok()?;
            native_paths_equal(&doc_path, path).then(|| entry.value().content.clone())
        })
    }

    /// Like [`Vfs::get_content_for_path`], but retries with the canonicalized
    /// path when the direct comparison misses. Canonicalization unifies path
    /// spellings the string comparison cannot: symlinks (`/tmp` → `/private/tmp`
    /// on macOS), Windows 8.3 short names (`RUNNER~1` vs `runneradmin`), `..`
    /// components, and mapped drives. [GitHub #110]
    pub fn get_content_for_path_canonical(&self, path: &str) -> Option<String> {
        self.get_content_for_path(path).or_else(|| {
            let canonical = std::fs::canonicalize(path).ok()?;
            self.get_content_for_path(&canonical.to_string_lossy())
        })
    }

    /// Read the live buffer for `file_path` when the editor has the document
    /// open (trying canonical path spellings too), else the on-disk text.
    /// Every feature that consumes file content by native path must prefer
    /// the buffer — sorting or analyzing yesterday's save corrupts the
    /// user's unsaved edits. [GitHub #110]
    pub fn read_live_or_disk(&self, file_path: &str) -> anyhow::Result<String> {
        use anyhow::Context;
        if let Some(content) = self.get_content_for_path_canonical(file_path) {
            return Ok(content);
        }
        tracing::trace!("VFS miss for {file_path}, reading from disk");
        std::fs::read_to_string(file_path).with_context(|| format!("read {file_path}"))
    }

    /// Get the current version of a document.
    pub fn get_version(&self, uri: &Uri) -> Option<i32> {
        self.documents.get(uri).map(|d| d.version)
    }

    /// Iterate over all open documents.
    pub fn iter(&self) -> dashmap::iter::Iter<'_, Uri, DocumentState> {
        self.documents.iter()
    }
}

/// Compare two native paths for equality. Windows verbatim (`\\?\`) prefixes
/// are ignored and the comparison is case-insensitive on Windows, where the
/// filesystem is too: editors lowercase the drive letter (`c:`) while
/// `std::fs::canonicalize` uppercases it (`\\?\C:`).
fn native_paths_equal(left: &str, right: &str) -> bool {
    let (left, right) = (strip_verbatim(left), strip_verbatim(right));
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

/// Strip the Windows verbatim prefix `std::fs::canonicalize` adds:
/// `\\?\C:\...` becomes `C:\...` and `\\?\UNC\server\share\...` becomes
/// `\\server\share\...`. A bare `\\?\` strip would leave the UNC form as
/// `UNC\server\share\...`, which can never equal the plain spelling — so
/// every network-share document would miss the VFS. [GitHub #110]
fn strip_verbatim(path: &str) -> std::borrow::Cow<'_, str> {
    if let Some(unc_rest) = path.strip_prefix(r"\\?\UNC\") {
        return std::borrow::Cow::Owned(format!(r"\\{unc_rest}"));
    }
    std::borrow::Cow::Borrowed(path.strip_prefix(r"\\?\").unwrap_or(path))
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test code — panics are the correct failure mode"
    )]

    use super::*;

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

    #[test]
    fn get_content_for_path_canonical_resolves_indirect_spellings() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sub");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Program.cs");
        std::fs::write(&file, "class OnDisk {}").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();

        let vfs = Vfs::new();
        let uri: Uri = url::Url::from_file_path(&canonical)
            .unwrap()
            .to_string()
            .parse()
            .unwrap();
        vfs.open(uri, 1, "buffer text".to_string());

        let indirect = dir.join("..").join("sub").join("Program.cs");
        let found = vfs.get_content_for_path_canonical(&indirect.to_string_lossy());
        assert_eq!(
            found.as_deref(),
            Some("buffer text"),
            "an indirect path spelling must still find the open buffer"
        );
    }
}
