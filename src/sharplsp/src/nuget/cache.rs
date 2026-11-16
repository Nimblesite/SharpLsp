//! Time-based cache for `NuGet` API responses.
//!
//! Search results are cached for 60 seconds, version lists for 5 minutes.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// Thread-safe cache with per-entry TTL.
pub struct TtlCache<V> {
    /// Map of cache keys to (value, `insertion_time`) pairs.
    entries: DashMap<String, (V, Instant)>,
    /// Maximum age before an entry is considered stale.
    ttl: Duration,
}

impl<V: Clone> TtlCache<V> {
    /// Create a new cache with the given time-to-live per entry.
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: DashMap::new(),
            ttl,
        }
    }

    /// Get a cached value if it exists and hasn't expired.
    pub fn get(&self, key: &str) -> Option<V> {
        let entry = self.entries.get(key)?;
        let (value, inserted_at) = entry.value();
        if inserted_at.elapsed() < self.ttl {
            Some(value.clone())
        } else {
            drop(entry);
            let _ = self.entries.remove(key);
            None
        }
    }

    /// Insert or update a cache entry, first dropping every expired one: keys
    /// are query texts that are rarely asked twice, so eviction on read alone
    /// would keep each stale response resident forever.
    pub fn insert(&self, key: String, value: V) {
        self.entries
            .retain(|_, (_, inserted_at)| inserted_at.elapsed() < self.ttl);
        let _ = self.entries.insert(key, (value, Instant::now()));
    }
}

/// Global caches for `NuGet` API responses.
/// Lazily-initialized cache for `NuGet` search results (60s TTL).
static SEARCH_CACHE: std::sync::OnceLock<TtlCache<serde_json::Value>> = std::sync::OnceLock::new();
/// Lazily-initialized cache for `NuGet` version lists (5 min TTL).
static VERSIONS_CACHE: std::sync::OnceLock<TtlCache<Vec<String>>> = std::sync::OnceLock::new();
/// Lazily-initialized shared HTTP client for `NuGet` API requests.
static HTTP_CLIENT: std::sync::OnceLock<Mutex<Option<reqwest::Client>>> =
    std::sync::OnceLock::new();

/// Return the shared search-result cache, creating it on first access.
pub fn search_cache() -> &'static TtlCache<serde_json::Value> {
    SEARCH_CACHE.get_or_init(|| TtlCache::new(Duration::from_mins(1)))
}

/// Return the shared version-list cache, creating it on first access.
pub fn versions_cache() -> &'static TtlCache<Vec<String>> {
    VERSIONS_CACHE.get_or_init(|| TtlCache::new(Duration::from_mins(5)))
}

/// Get or create the shared HTTP client.
pub fn http_client() -> reqwest::Client {
    let lock = HTTP_CLIENT.get_or_init(|| Mutex::new(None));
    let mut guard = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(ref client) = *guard {
        return client.clone();
    }
    let client = reqwest::Client::builder()
        .user_agent("sharplsp")
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    *guard = Some(client.clone());
    client
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_returns_none_for_a_missing_key() {
        let cache: TtlCache<i32> = TtlCache::new(Duration::from_mins(1));
        assert_eq!(cache.get("absent"), None);
    }

    #[test]
    fn get_returns_a_fresh_value() {
        let cache = TtlCache::new(Duration::from_mins(1));
        cache.insert("k".to_string(), 7);
        assert_eq!(cache.get("k"), Some(7));
    }

    #[test]
    fn get_evicts_an_expired_value() {
        // A zero TTL makes any stored entry immediately stale, so the get must
        // take the eviction branch and return None.
        let cache = TtlCache::new(Duration::ZERO);
        cache.insert("k".to_string(), 7);
        assert_eq!(cache.get("k"), None);
    }

    /// Memory leak: search results are keyed by the query text, and the
    /// package search asks once per keystroke and page, so an expired entry
    /// was only dropped if that exact query was asked again — in practice
    /// never, and every response body stayed resident for the host's life.
    #[test]
    fn inserting_sweeps_expired_entries_for_queries_never_asked_again() {
        let cache = TtlCache::new(Duration::ZERO);
        for query in ["N", "Ne", "New", "Newt", "Newto", "Newtonsoft"] {
            cache.insert(
                format!("{query}|false|20|0"),
                serde_json::json!({ "q": query }),
            );
        }
        assert!(
            cache.entries.len() <= 1,
            "expired search results must not accumulate, held {}",
            cache.entries.len()
        );
        assert_eq!(
            cache.get("Newtonsoft|false|20|0"),
            None,
            "a stale entry is never served"
        );
        assert_eq!(cache.entries.len(), 0, "reading a stale entry drops it");
    }

    #[test]
    fn http_client_returns_a_reusable_client() {
        let first = http_client();
        let second = http_client();
        // Both handles point at the same lazily-built client.
        drop((first, second));
    }
}
