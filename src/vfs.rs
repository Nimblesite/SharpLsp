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

    /// Get the current version of a document.
    pub fn get_version(&self, uri: &Uri) -> Option<i32> {
        self.documents.get(uri).map(|d| d.version)
    }

    /// Iterate over all open documents.
    pub fn iter(&self) -> dashmap::iter::Iter<'_, Uri, DocumentState> {
        self.documents.iter()
    }
}
