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
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// Strip the `\\?\` verbatim prefix `std::fs::canonicalize` adds on Windows.
fn strip_verbatim(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}
