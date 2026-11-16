//! The push gate: which fetch may still publish for a document, and whether
//! its latest publication is provisional. Implements [DIAG-PUSH-GATE].
//!
//! Both maps hold only documents in play: a close retires the document, and
//! a settled set leaves the provisional set, so neither outlives its files.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;

use dashmap::{DashMap, DashSet};
use lsp_types::Uri;

/// Source of every push generation, across all documents. One shared counter
/// is what lets a close forget a document: its reopened pushes draw numbers
/// no fetch begun before the close can hold (GitHub #160).
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Latest push generation per open or pushed document URI: a completed fetch
/// older than the newest known text must not publish, and the newest
/// generation retries on failure until published or superseded.
pub(super) static PUSH_GENERATIONS: LazyLock<DashMap<String, u64>> = LazyLock::new(DashMap::new);

/// URIs whose LATEST publication still carries the restore-pending code — a
/// tier-2 placeholder that a background restore is about to replace. While a
/// document is here, a semantic response must not reach the editor before
/// its diagnostics are re-fetched and republished
/// ([`super::converge_provisional`]); otherwise completion or hover can reveal
/// the restored tier-1 references while the placeholder's phantom `CS0246`s
/// are still the published truth. Implements
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
pub(super) static PROVISIONAL_PUBLISHED: LazyLock<DashSet<String>> = LazyLock::new(DashSet::new);

/// Register a new push generation for `uri`, superseding in-flight fetches.
pub(super) fn next_generation(uri: &Uri) -> u64 {
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let _ = PUSH_GENERATIONS.insert(uri.to_string(), generation);
    generation
}

/// Whether `generation` is still the newest push generation for `uri`.
pub(super) fn is_current(uri: &Uri, generation: u64) -> bool {
    current_generation(uri) == Some(generation)
}

/// The newest push generation registered for `uri`, if any.
pub(super) fn current_generation(uri: &Uri) -> Option<u64> {
    PUSH_GENERATIONS
        .get(uri.as_str())
        .map(|generation| *generation)
}

/// Forget a closed document: every fetch begun for it is superseded.
pub(super) fn retire(uri: &Uri) {
    let _ = PUSH_GENERATIONS.remove(uri.as_str());
}

/// Record whether `uri`'s latest publication is provisional.
pub(super) fn mark_published(uri: &Uri, provisional: bool) {
    if provisional {
        let _ = PROVISIONAL_PUBLISHED.insert(uri.to_string());
    } else {
        let _ = PROVISIONAL_PUBLISHED.remove(uri.as_str());
    }
}

/// Whether the latest publication for `uri` is a tier-2 placeholder that a
/// background restore is about to replace. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
pub fn published_set_is_provisional(uri: &Uri) -> bool {
    PROVISIONAL_PUBLISHED.contains(uri.as_str())
}

/// Every document with a push generation: published, or being fetched.
pub(super) fn tracked() -> Vec<String> {
    PUSH_GENERATIONS
        .iter()
        .map(|entry| entry.key().clone())
        .collect()
}
