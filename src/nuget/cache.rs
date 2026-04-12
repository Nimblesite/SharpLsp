//! Time-based cache for `NuGet` API responses.
//!
//! Search results are cached for 60 seconds, version lists for 5 minutes.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use dashmap::DashMap;

/// Thread-safe cache with per-entry TTL.
pub struct TtlCache<V> {
    entries: DashMap<String, (V, Instant)>,
    ttl: Duration,
}

impl<V: Clone> TtlCache<V> {
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

    /// Insert or update a cache entry.
    pub fn insert(&self, key: String, value: V) {
        let _ = self.entries.insert(key, (value, Instant::now()));
    }
}

/// Global caches for `NuGet` API responses.
static SEARCH_CACHE: std::sync::OnceLock<TtlCache<serde_json::Value>> = std::sync::OnceLock::new();
static VERSIONS_CACHE: std::sync::OnceLock<TtlCache<Vec<String>>> = std::sync::OnceLock::new();
static HTTP_CLIENT: std::sync::OnceLock<Mutex<Option<reqwest::Client>>> =
    std::sync::OnceLock::new();

pub fn search_cache() -> &'static TtlCache<serde_json::Value> {
    SEARCH_CACHE.get_or_init(|| TtlCache::new(Duration::from_secs(60)))
}

pub fn versions_cache() -> &'static TtlCache<Vec<String>> {
    VERSIONS_CACHE.get_or_init(|| TtlCache::new(Duration::from_secs(300)))
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
        .user_agent("forge-lsp")
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    *guard = Some(client.clone());
    client
}
