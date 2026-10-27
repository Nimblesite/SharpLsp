//! Background compiler work never holds up the user. The compiler answers one
//! request at a time, and a cold code lens counts references across every
//! project, so a hover queued behind one waited for the whole count (#504). Every
//! other document request preempts the lenses queued or in flight on its
//! compiler before it waits its own turn: the user waits on it, or, for a
//! forwarded edit, the host's main loop does. The lens reads as cancelled, and
//! its handler asks the client for it again. Diagnostic pulls reach the compiler
//! as `workspace/diagnostics`, so they never preempt a lens.
//! Implements [SHARPLSP-FEATURES-CODE-LENS].
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use lspkit_server::CancellationToken;
use tracing::info;

/// Requests nobody waits on, which every other document request preempts.
const BACKGROUND: &[&str] = &["textDocument/codeLens"];

/// The background requests an interactive one may cancel.
#[derive(Default)]
pub(super) struct Preemption {
    /// Every background request queued or in flight, by registration.
    running: Mutex<Vec<(u64, CancellationToken)>>,
    /// The next registration.
    next: AtomicU64,
}

/// One background request's registration, released when it is dropped.
pub(super) struct Background<'a> {
    /// The registry it is held in.
    owner: &'a Preemption,
    /// Its registration.
    id: u64,
    /// Cancelled with the caller's token, or by a preemption.
    pub(super) token: CancellationToken,
}

impl Preemption {
    /// Register `method` when it is background work. Its token is cancelled
    /// with `caller`'s, or when an interactive request preempts it.
    pub(super) fn begin(
        &self,
        method: &str,
        caller: Option<&CancellationToken>,
    ) -> Option<Background<'_>> {
        if !BACKGROUND.contains(&method) {
            return None;
        }
        let token = caller.map_or_else(CancellationToken::new, CancellationToken::child_token);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.with_running(|running| running.push((id, token.clone())));
        Some(Background {
            owner: self,
            id,
            token,
        })
    }

    /// Cancel every background request when `method` is a document request that is
    /// not background work itself.
    pub(super) fn preempt_for(&self, method: &str) {
        if !method.starts_with("textDocument/") || BACKGROUND.contains(&method) {
            return;
        }
        let preempted = self.with_running(std::mem::take);
        for (_, token) in &preempted {
            token.cancel();
        }
        if !preempted.is_empty() {
            info!(
                method,
                count = preempted.len(),
                "Background compiler work preempted"
            );
        }
    }

    /// The registry, still usable after a panic elsewhere left its lock poisoned.
    fn with_running<T>(&self, change: impl FnOnce(&mut Vec<(u64, CancellationToken)>) -> T) -> T {
        change(&mut self.running.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl Drop for Background<'_> {
    fn drop(&mut self) {
        let id = self.id;
        self.owner
            .with_running(|running| running.retain(|(each, _)| *each != id));
    }
}
