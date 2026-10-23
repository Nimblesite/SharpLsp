//! Responsive diagnostic requests with shared cancellation. [DIAG-ANALYSIS-CANCELLATION]

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use lsp_server::{Message, Request, Response};
use lspkit_server::pull::PullStore;
use lspkit_server::{CancellationToken, Dispatcher, HandlerResult, JsonRpcError, ReplyGate};
use serde_json::{json, Value};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// Backend wiring, retained independently of a single request's lifetime.
#[derive(Clone)]
struct Context {
    /// Sidecar IPC executor.
    runtime: tokio::runtime::Handle,
    /// F# first, then C# compiler engine.
    engines: [Option<Arc<SidecarManager>>; 2],
    /// Authoritative editor versions and overlays.
    vfs: Arc<Vfs>,
    /// Connection-owned protocol sink.
    sender: crossbeam_channel::Sender<Message>,
}

/// One request's snapshot identity and ordered output lifetime; no result cache.
pub(super) struct Snapshot {
    /// Shared Salsa owner; computed values are retained only there.
    pub store: PullStore,
    /// Input revision captured before work was scheduled.
    revision: u64,
    /// Canonical dispatcher cancellation token.
    cancel: CancellationToken,
    /// Serializes partial sends against the terminal reply.
    reply: ReplyGate,
    /// Connection-owned protocol sink.
    sender: crossbeam_channel::Sender<Message>,
}

impl Snapshot {
    /// Check before semantic work and before emitting any part of its result.
    pub fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err(Interrupted::Cancelled.into());
        }
        if self.store.revision() != self.revision {
            return Err(Interrupted::Superseded.into());
        }
        Ok(())
    }

    /// Cancellation cannot interleave a terminal response ahead of this partial.
    pub fn partial(&self, token: &lsp_types::ProgressToken, report: &Value) -> Result<()> {
        self.reply
            .emit(|| {
                self.check()?;
                let notification = lsp_server::Notification::new(
                    "$/progress".to_owned(),
                    json!({"token": token, "value": {"items": [report]}}),
                );
                self.sender.send(Message::Notification(notification))?;
                Ok::<(), anyhow::Error>(())
            })
            .map_err(anyhow::Error::from)
    }
}

/// Own the canonical dispatcher; dropping the host cancels all its work.
pub struct Requests {
    /// Sole request cancellation registry.
    dispatcher: Dispatcher,
    /// Backend wiring shared with in-flight work.
    context: Context,
}

impl Requests {
    /// Connect compiler engines without performing any analysis.
    pub fn new(
        runtime: &tokio::runtime::Runtime,
        engines: [Option<&Arc<SidecarManager>>; 2],
        vfs: &Arc<Vfs>,
        sender: crossbeam_channel::Sender<Message>,
    ) -> Self {
        Self {
            dispatcher: Dispatcher::new(),
            context: Context {
                runtime: runtime.handle().clone(),
                engines: engines.map(Option::<&Arc<SidecarManager>>::cloned),
                vfs: Arc::clone(vfs),
                sender,
            },
        }
    }

    /// Register before scheduling, so an immediate cancellation cannot get lost.
    pub fn dispatch(&self, request: &Request, runtime: &tokio::runtime::Runtime) -> Result<bool> {
        if !matches!(
            request.method.as_str(),
            "textDocument/diagnostic" | "workspace/diagnostic"
        ) {
            return Ok(false);
        }
        let reply = ReplyGate::default();
        let store = super::state::store()?;
        let revision = store.revision();
        let future = self.prepare(request.clone(), reply.clone(), store.clone(), revision)?;
        let (id, sender) = (request.id.clone(), self.context.sender.clone());
        drop(runtime.spawn(async move {
            let result = future.await;
            if reply
                .finish(|| {
                    sender.send(Message::Response(response(
                        id,
                        current(result, &store, revision),
                    )))
                })
                .is_err()
            {
                warn!("Diagnostic reply connection closed");
            }
        }));
        Ok(true)
    }

    /// Capture a coherent input epoch and register its worker before spawning.
    fn prepare(
        &self,
        request: Request,
        reply: ReplyGate,
        store: PullStore,
        revision: u64,
    ) -> Result<Pin<Box<dyn Future<Output = HandlerResult> + Send>>> {
        let context = self.context.clone();
        let id = serde_json::from_value(serde_json::to_value(&request.id)?)?;
        let sender = context.sender.clone();
        Ok(Box::pin(self.dispatcher.prepare_call(
            id,
            move |cancel| {
                let snapshot = Snapshot {
                    store,
                    revision,
                    cancel,
                    reply,
                    sender,
                };
                compute(request, context, snapshot)
            },
        )?))
    }

    /// Unknown and already completed cancellation IDs are harmless.
    pub fn cancel(&self, params: &Value) {
        if let Some(id) = params
            .get("id")
            .and_then(|id| serde_json::from_value(id.clone()).ok())
        {
            self.dispatcher.cancel(&id);
        }
    }

    /// End outstanding requests before the compiler engines are stopped.
    pub fn cancel_all(&self) {
        self.dispatcher.cancel_all();
    }
}

impl Drop for Requests {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

/// Cancellation answers immediately; the worker stops between documents.
async fn compute(request: Request, context: Context, snapshot: Snapshot) -> HandlerResult {
    let cancel = snapshot.cancel.clone();
    let worker = tokio::task::spawn_blocking(move || analyze(request, &context, &snapshot));
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(Interrupted::Cancelled.into()),
        result = worker => result.map_err(anyhow::Error::from).and_then(std::convert::identity),
    };
    match result {
        Ok(value) => HandlerResult::Ok(value),
        Err(error) => HandlerResult::Err(rpc_error(&error)),
    }
}

/// Execute compiler pulls outside the foreground protocol loop.
fn analyze(request: Request, context: &Context, snapshot: &Snapshot) -> Result<Value> {
    snapshot.check()?;
    let result = if request.method == "workspace/diagnostic" {
        super::handle_workspace_diagnostic(
            request,
            &context.runtime,
            context.engines.each_ref().map(Option::as_ref),
            &context.vfs,
            snapshot,
        )
    } else {
        super::handle_document_diagnostic(request, &context.vfs, snapshot)
    }?;
    snapshot.check()?;
    Ok(result)
}

/// Preserve protocol cancellation and request-error semantics at the adapter boundary.
fn rpc_error(error: &anyhow::Error) -> JsonRpcError {
    match error.downcast_ref::<Interrupted>() {
        Some(Interrupted::Cancelled) => JsonRpcError::new(-32800, "Diagnostic request cancelled"),
        _ if error.downcast_ref::<serde_json::Error>().is_some() => {
            JsonRpcError::new(-32602, "Invalid diagnostic parameters")
        }
        _ => JsonRpcError::new(-32802, "Diagnostic snapshot unavailable or superseded")
            .with_data(json!({"retriggerRequest": true})),
    }
}

/// Convert shared dispatcher outcomes into the existing lsp-server wire shape.
fn response(id: lsp_server::RequestId, result: HandlerResult) -> Response {
    match result {
        HandlerResult::Ok(value) => Response::new_ok(id, value),
        HandlerResult::Err(error) => Response {
            id,
            response_result: Err(lsp_server::ResponseError {
                code: error.code,
                message: error.message,
                data: error.data,
            }),
        },
        _ => Response::new_err(
            id,
            -32603,
            "Unsupported diagnostic handler result".to_owned(),
        ),
    }
}

/// Validate the input epoch at the serialized output boundary as well.
fn current(result: HandlerResult, store: &PullStore, revision: u64) -> HandlerResult {
    if matches!(&result, HandlerResult::Ok(_)) && store.revision() != revision {
        HandlerResult::Err(rpc_error(&Interrupted::Superseded.into()))
    } else {
        result
    }
}

#[derive(Debug)]
/// Why this query's result cannot be presented as current truth.
enum Interrupted {
    /// The client cancelled this request.
    Cancelled,
    /// A source, workspace or configuration mutation superseded its snapshot.
    Superseded,
}
impl std::fmt::Display for Interrupted {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("diagnostic request interrupted")
    }
}
impl std::error::Error for Interrupted {}
