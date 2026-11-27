//! Ingress registrations, held from the protocol reader until the loop prepares
//! the request. [DIAG-ANALYSIS-CANCELLATION] [LSP-PULL-CANCELLATION]
//!
//! The reader registers a request before the foreground loop, which may be busy,
//! sees it, so an immediate `$/cancelRequest` is never lost. lspkit's
//! [`QueuedRequest`] owns that registration, and dropping it early would release it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};

use lspkit_server::{QueuedRequest, RequestId};

/// The reader's registrations that no dispatch has adopted yet.
static QUEUED: LazyLock<Mutex<HashMap<RequestId, QueuedRequest>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Keep `guard` until its request is prepared. A reused ID replaces, and so
/// releases, the older registration.
pub(super) fn hold(guard: QueuedRequest) {
    let mut queued = QUEUED.lock().unwrap_or_else(PoisonError::into_inner);
    drop(queued.insert(guard.id().clone(), guard));
}

/// Release `id`'s ingress registration once `prepare` has adopted it, or
/// refused it: a prepared request keeps the control it adopted.
pub(super) fn release(id: &RequestId) {
    let mut queued = QUEUED.lock().unwrap_or_else(PoisonError::into_inner);
    drop(queued.remove(id));
}
