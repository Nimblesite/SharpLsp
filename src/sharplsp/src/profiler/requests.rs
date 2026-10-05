//! Cancellable diagnostic requests. Implements [PROFILER-PERFORMANCE].

use lsp_server::{Message, Request, RequestId, Response};
use std::collections::HashMap;
use tokio::sync::oneshot;
use tracing::{info, warn};

/// Owns cancellation senders; dropping the registry cancels outstanding diagnostics.
#[derive(Default)]
pub struct Requests {
    /// Closed receivers are pruned as requests finish.
    pending: HashMap<RequestId, oneshot::Sender<()>>,
}

impl Requests {
    /// Start supported diagnostic work while leaving the LSP message loop responsive.
    pub fn dispatch(
        &mut self,
        req: &Request,
        runtime: &tokio::runtime::Runtime,
        sender: &crossbeam_channel::Sender<Message>,
    ) -> bool {
        let Some(operation) = super::handlers::analysis(req, sender.clone()) else {
            return false;
        };
        self.pending.retain(|_, cancel| !cancel.is_closed());
        let (cancel, cancelled) = oneshot::channel();
        let _ = self.pending.insert(req.id.clone(), cancel);
        let (id, method, sender) = (req.id.clone(), req.method.clone(), sender.clone());
        drop(runtime.spawn(complete(id, method, operation, cancelled, sender)));
        true
    }

    /// Consume a standard LSP cancel notification; unknown and completed IDs are harmless.
    pub fn cancel(&mut self, params: &serde_json::Value) {
        let Some(id) = params
            .get("id")
            .and_then(|id| serde_json::from_value(id.clone()).ok())
        else {
            return;
        };
        if let Some(cancel) = self.pending.remove(&id) {
            let _ = cancel.send(());
        }
    }
}

/// Emit exactly one response after completion or cancellation.
async fn complete(
    id: RequestId,
    method: String,
    operation: super::handlers::Operation,
    mut cancelled: oneshot::Receiver<()>,
    sender: crossbeam_channel::Sender<Message>,
) {
    let started = std::time::Instant::now();
    info!(method, "Profiler request started");
    let response = tokio::select! {
        biased;
        _ = &mut cancelled => Response::new_err(id, -32800, "Profiler operation cancelled".to_string()),
        result = operation => crate::request_response(id, &method, result),
    };
    info!(
        method,
        ms = started.elapsed().as_millis(),
        "Profiler request finished"
    );
    if sender.send(Message::Response(response)).is_err() {
        warn!(method, "Profiler response connection closed");
    }
}
