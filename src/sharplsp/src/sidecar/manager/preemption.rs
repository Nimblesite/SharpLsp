//! Background compiler work never holds up the user. The compiler answers one
//! request at a time, and a cold code lens counts references across every
//! project, so a hover queued behind one waited for the whole count (#504). Every
//! other document request preempts the lenses queued or in flight on its
//! compiler before it waits its own turn: the user waits on it, or, for a
//! forwarded edit, the host's main loop does. The lens reads as cancelled, and
//! its handler asks the client for it again. Diagnostic pulls reach the compiler
//! as `workspace/diagnostics`, so they never preempt a lens.
//!
//! The warm-up of an opened workspace is speculative, so it yields further:
//! every request preempts it except the host's own polling and the walk itself.
//! A held file read in a warm-up must never stall a solution switch or a
//! diagnostic pull (#513).
//! Implements [SHARPLSP-FEATURES-CODE-LENS] and [SHARPLSP-FEATURES-WARM-UP].
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use lspkit_server::CancellationToken;
use tracing::info;

use super::warm_up::WARM_UP;

/// Requests nobody waits on, which other requests preempt.
const BACKGROUND: &[&str] = &["textDocument/codeLens", WARM_UP];

/// Requests the host sends on its own schedule: they never preempt a warm-up,
/// which would otherwise never finish.
const POLLING: &[&str] = &["workspace/diagnostics/documents"];

/// Whether `method` preempts the background request `background`.
fn preempts(method: &str, background: &str) -> bool {
    if background == WARM_UP {
        method != WARM_UP && !POLLING.contains(&method)
    } else {
        method.starts_with("textDocument/") && !BACKGROUND.contains(&method)
    }
}

/// One background request in flight or queued: its method and its token.
type Running = (u64, &'static str, CancellationToken);

/// The background requests an interactive one may cancel.
#[derive(Default)]
pub(super) struct Preemption {
    /// Every background request queued or in flight, by registration.
    running: Mutex<Vec<Running>>,
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
    /// with `caller`'s, or when a request it yields to preempts it.
    pub(super) fn begin(
        &self,
        method: &str,
        caller: Option<&CancellationToken>,
    ) -> Option<Background<'_>> {
        let kind = BACKGROUND.iter().copied().find(|each| *each == method)?;
        let token = caller.map_or_else(CancellationToken::new, CancellationToken::child_token);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.with_running(|running| running.push((id, kind, token.clone())));
        Some(Background {
            owner: self,
            id,
            token,
        })
    }

    /// Cancel every background request that `method` preempts.
    pub(super) fn preempt_for(&self, method: &str) {
        let preempted = self.with_running(|running| {
            let (yielding, kept) = std::mem::take(running)
                .into_iter()
                .partition(|(_, background, _)| preempts(method, background));
            *running = kept;
            yielding
        });
        for (_, _, token) in &preempted {
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
    fn with_running<T>(&self, change: impl FnOnce(&mut Vec<Running>) -> T) -> T {
        change(&mut self.running.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

impl Drop for Background<'_> {
    fn drop(&mut self) {
        let id = self.id;
        self.owner
            .with_running(|running| running.retain(|(each, _, _)| *each != id));
    }
}
