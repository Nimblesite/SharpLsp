//! Virtual File System — authoritative document state for open files.

use dashmap::DashMap;
use lsp_types::Uri;

/// Stores the current content of all open documents.
pub struct Vfs {
    documents: DashMap<Uri, DocumentState>,
}

pub struct DocumentState {
    pub content: String,
    pub version: i32,
}

impl Vfs {
    pub fn new() -> Self {
        Self {
            documents: DashMap::new(),
        }
    }

    /// Open a document (textDocument/didOpen).
    pub fn open(&self, uri: Uri, version: i32, text: String) {
        self.documents.insert(
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
        self.documents.remove(uri);
    }

    /// Get the current content of a document.
    pub fn get_content(&self, uri: &Uri) -> Option<String> {
        self.documents.get(uri).map(|d| d.content.clone())
    }
}
