//! Navigation result cache for definition/typeDefinition/declaration.
//!
//! Caches serialized JSON responses keyed by
//! `(document_uri, document_version, line, character, method)`.
//! Returns cached results in <1ms on hit. Automatically invalidated
//! when the document changes or closes.

use std::collections::HashMap;

use lsp_types::Uri;

/// Cache key: position + method within a specific document version.
#[derive(Clone, Hash, Eq, PartialEq)]
struct CacheKey {
    /// Line number of the cursor position.
    line: u32,
    /// Column (character offset) of the cursor position.
    character: u32,
    /// LSP method name (e.g. `textDocument/definition`).
    method: String,
}

/// Cached entry with the document version at cache time.
struct CacheEntry {
    /// Document version when this entry was cached.
    version: i32,
    /// Serialized navigation result.
    value: serde_json::Value,
}

/// Per-document navigation cache.
///
/// Stores cached navigation results per `(uri, position, method)`.
/// A version mismatch invalidates the entry.
pub struct NavCache {
    /// Map from `(uri, cache_key)` to cached navigation result.
    entries: HashMap<(String, CacheKey), CacheEntry>,
}

impl NavCache {
    /// Create an empty navigation cache.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Look up a cached navigation result.
    pub fn get(
        &self,
        uri: &str,
        version: i32,
        line: u32,
        character: u32,
        method: &str,
    ) -> Option<&serde_json::Value> {
        let key = (
            uri.to_string(),
            CacheKey {
                line,
                character,
                method: method.to_string(),
            },
        );
        let entry = self.entries.get(&key)?;
        if entry.version == version {
            Some(&entry.value)
        } else {
            None
        }
    }

    /// Store a navigation result in the cache.
    ///
    /// Empty results (null or `[]`) are silently skipped — they indicate
    /// the sidecar hasn't finished loading, so caching them would prevent
    /// retries from producing a real result.
    pub fn insert(
        &mut self,
        uri: &str,
        version: i32,
        line: u32,
        character: u32,
        method: &str,
        value: serde_json::Value,
    ) {
        if is_empty_nav_result(&value) {
            return;
        }
        let key = (
            uri.to_string(),
            CacheKey {
                line,
                character,
                method: method.to_string(),
            },
        );
        let _ = self.entries.insert(key, CacheEntry { version, value });
    }

    /// Invalidate all cached entries for a document.
    pub fn invalidate(&mut self, uri: &Uri) {
        let uri_str = uri.as_str();
        self.entries.retain(|(k, _), _| k != uri_str);
    }
}

/// Check if a navigation result is empty (null or empty array). Empty results
/// mean "the sidecar had nothing yet", never "definitively no results" — both
/// the cache and the cross-language fallback treat them as retryable.
pub fn is_empty_nav_result(value: &serde_json::Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::NavCache;

    #[test]
    fn insert_skips_empty_array_results() {
        // An empty location list means the sidecar may still be loading the
        // workspace; caching it would pin "no results" until the next edit
        // bumps the document version. [GitHub #110]
        let mut cache = NavCache::new();
        cache.insert(
            "file:///test.cs",
            1,
            2,
            3,
            "textDocument/references",
            json!([]),
        );

        assert!(
            cache
                .get("file:///test.cs", 1, 2, 3, "textDocument/references")
                .is_none(),
            "empty arrays must not be cached"
        );
    }

    #[test]
    fn get_returns_none_for_stale_document_version() {
        let mut cache = NavCache::new();
        cache.insert(
            "file:///test.cs",
            1,
            2,
            3,
            "textDocument/definition",
            json!({ "ok": true }),
        );

        assert!(cache
            .get("file:///test.cs", 2, 2, 3, "textDocument/definition")
            .is_none());
    }
}
