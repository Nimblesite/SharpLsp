//! Hover result cache keyed by `(document_uri, document_version, position)`.
//!
//! Returns cached results instantly when the document hasn't changed and
//! the cursor is at a previously-hovered position. Automatically invalidates
//! when the document version changes.

use std::collections::HashMap;

use lsp_types::{Position, Uri};

/// A single cached hover response (pre-serialized JSON value).
struct CachedHover {
    /// Document version at the time the hover was computed.
    version: i32,
    /// The serialized LSP `Hover | null` result.
    value: serde_json::Value,
}

/// Per-document hover cache.
///
/// Stores one cached hover per `(uri, position)`. A version mismatch
/// invalidates the entry — the caller must re-query the sidecar.
pub struct HoverCache {
    /// Map from `(uri, position)` to cached result.
    entries: HashMap<(Uri, Position), CachedHover>,
}

#[expect(dead_code, reason = "wired in a follow-up PR")]
impl HoverCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Look up a cached hover result.
    ///
    /// Returns `Some(value)` if the cache has a result for this exact
    /// `(uri, version, position)` triple. Returns `None` on miss.
    pub fn get(&self, uri: &Uri, version: i32, position: Position) -> Option<&serde_json::Value> {
        let entry = self.entries.get(&(uri.clone(), position))?;
        if entry.version == version {
            Some(&entry.value)
        } else {
            None
        }
    }

    /// Store a hover result in the cache.
    pub fn insert(&mut self, uri: Uri, version: i32, position: Position, value: serde_json::Value) {
        self.entries
            .insert((uri, position), CachedHover { version, value });
    }

    /// Invalidate all cached entries for a document.
    ///
    /// Called on `didChange` / `didClose` to ensure stale results
    /// are never returned.
    pub fn invalidate(&mut self, uri: &Uri) {
        self.entries.retain(|(k, _), _| k != uri);
    }
}
