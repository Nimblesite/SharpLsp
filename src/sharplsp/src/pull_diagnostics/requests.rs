//! Responsive diagnostic requests with shared cancellation. [DIAG-ANALYSIS-CANCELLATION]

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use anyhow::Result;
use lsp_server::{Message, Notification, Request, Response};
use lspkit_server::pull::{AnalysisError, PullError, PullStore};
use lspkit_server::{
    CancellationHandle, CancellationToken, Dispatcher, HandlerResult, JsonRpcError, ReplyGate,
};
use serde_json::{json, Value};
use tracing::warn;

use crate::sidecar::manager::{CompilerRefusal, SidecarManager};
use crate::vfs::Vfs;

mod interest;

#[cfg(test)]
mod rpc_error_tests;

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
    /// Diagnostic store revision captured before work was scheduled. `None` for
    /// document requests (rename, codeLens): their own document's changes
    /// supersede them through [`interest`], never unrelated store churn.
    pub(super) revision: Option<u64>,
    /// Canonical dispatcher cancellation token.
    cancel: CancellationToken,
    /// Serializes partial sends against the terminal reply.
    reply: ReplyGate,
    /// Connection-owned protocol sink.
    sender: crossbeam_channel::Sender<Message>,
}

impl Snapshot {
    /// Actual execution lifetime forwarded to the shared query and compiler transport.
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancel
    }

    /// Check before semantic work and before emitting any part of its result.
    pub fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err(Interrupted::Cancelled.into());
        }
        let current = self.store.revision();
        if self.revision.is_some_and(|revision| revision != current) {
            tracing::debug!(
                revision = self.revision,
                current,
                "Diagnostic snapshot superseded"
            );
            return Err(Interrupted::Superseded.into());
        }
        Ok(())
    }

    /// One diagnostic report of a partial workspace pull.
    pub fn partial(&self, token: &lsp_types::ProgressToken, report: &Value) -> Result<()> {
        self.progress(token, &json!({"items": [report]}))
    }

    /// Cancellation cannot interleave a terminal response ahead of this partial.
    pub fn progress(&self, token: &lsp_types::ProgressToken, value: &Value) -> Result<()> {
        self.reply
            .emit(|| {
                self.check()?;
                let notification = lsp_server::Notification::new(
                    "$/progress".to_owned(),
                    json!({"token": token, "value": value}),
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
    /// Retain interest before FIFO forwarding, including pulls queued behind source updates.
    /// [DIAG-ANALYSIS-CANCELLATION] uses the dispatcher's sole cancellation registry.
    pub fn observe(cancellation: &CancellationHandle, request: &Request) -> Result<()> {
        if request.method == "sharplsp/loadSolution"
            && request
                .params
                .get("solutionPath")
                .is_some_and(Value::is_string)
        {
            cancellation.supersede_all();
        }
        if handles(request) {
            let id = serde_json::from_value(serde_json::to_value(&request.id)?)?;
            let interest = interest::request(request);
            if let Some(document) = interest.as_ref() {
                crate::semantic::requests::arrived(request, &document.resource);
            }
            cancellation.register(id, interest)?;
        }
        Ok(())
    }

    /// Release obsolete compiler work before a real input notification can wait on its IPC.
    /// [DIAG-ANALYSIS-CANCELLATION] changes interest, never the authoritative VFS here.
    pub fn changed(cancellation: &CancellationHandle, notification: &Notification) {
        interest::changed(cancellation, notification);
    }

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
    /// `settled` is an answer the input loop already knows, such as `null`
    /// for a position holding no symbol; it still replies through here, where
    /// the request was registered.
    pub fn dispatch(
        &self,
        request: &Request,
        runtime: &tokio::runtime::Runtime,
        settled: Option<Value>,
    ) -> Result<bool> {
        if !handles(request) {
            return Ok(false);
        }
        let reply = ReplyGate::default();
        let store = super::state::store()?;
        let revision = diagnostic(request).then(|| store.revision());
        let snapshot = (reply.clone(), store.clone(), revision);
        let (dispatcher, context) = (self.dispatcher.clone(), self.context.clone());
        let start = settled.map_or(Start::Now, Start::Settled);
        let future = prepare(&dispatcher, &context, request.clone(), snapshot, start)?;
        let (request, sender) = (request.clone(), self.context.sender.clone());
        drop(runtime.spawn(async move {
            let mut result = future.await;
            // Only its own document's change ends a position request: one a
            // lost watcher event or a reload superseded is asked again.
            // [SHARPLSP-ARCHITECTURE-ROUTING]
            for attempt in 1..=crate::semantic::requests::RETRIES {
                let snapshot = (reply.clone(), store.clone(), revision);
                let start = Start::After(crate::semantic::requests::retry_pause(attempt));
                let again = crate::semantic::requests::asks_again(&request, &result)
                    .then(|| prepare(&dispatcher, &context, request.clone(), snapshot, start).ok())
                    .flatten();
                let Some(next) = again else { break };
                tracing::debug!(
                    method = request.method,
                    attempt,
                    "Superseded request asked again"
                );
                result = next.await;
            }
            crate::semantic::requests::finished(&request);
            let (id, method) = (request.id, request.method);
            if reply
                .finish(|| {
                    let result = current(result, &store, revision);
                    let result = crate::semantic::requests::superseded(&method, result);
                    sender.send(Message::Response(response(id, result)))
                })
                .is_err()
            {
                warn!("Diagnostic reply connection closed");
            }
        }));
        Ok(true)
    }

    /// Unknown and already completed cancellation IDs are harmless.
    pub fn cancel(&self, params: &Value) {
        self.cancellation_handle().cancel_request(params);
    }

    /// Share only weak protocol control with the ingress reader, never compiler state.
    pub fn cancellation_handle(&self) -> CancellationHandle {
        self.dispatcher.cancellation_handle()
    }

    /// End outstanding requests before the compiler engines are stopped.
    pub fn cancel_all(&self) {
        self.dispatcher.cancel_all();
    }
}

/// How one attempt at a request begins.
enum Start {
    /// At once.
    Now,
    /// With an answer the input loop already knows; no work is done.
    Settled(Value),
    /// After a pause, for a request asked again while a reload settles. The
    /// pause is part of the registered attempt, so a cancellation ends it.
    After(std::time::Duration),
}

/// Capture a coherent input epoch and register its worker before spawning.
fn prepare(
    dispatcher: &Dispatcher,
    context: &Context,
    request: Request,
    (reply, store, revision): (ReplyGate, PullStore, Option<u64>),
    start: Start,
) -> Result<Pin<Box<dyn Future<Output = HandlerResult> + Send>>> {
    let context = context.clone();
    let id = serde_json::from_value(serde_json::to_value(&request.id)?)?;
    let sender = context.sender.clone();
    Ok(Box::pin(dispatcher.prepare_call(id, move |cancel| {
        let snapshot = Snapshot {
            store,
            revision,
            cancel,
            reply,
            sender,
        };
        compute(request, context, snapshot, start)
    })?))
}

/// The foreground and protocol reader agree on the requests owned by this dispatcher.
fn handles(request: &Request) -> bool {
    matches!(
        request.method.as_str(),
        "textDocument/diagnostic"
            | "workspace/diagnostic"
            | "textDocument/codeLens"
            | "textDocument/rename"
    ) || crate::semantic::requests::handles(&request.method)
}

/// Only diagnostic pulls are reports of the whole store's current truth.
fn diagnostic(request: &Request) -> bool {
    matches!(
        request.method.as_str(),
        "textDocument/diagnostic" | "workspace/diagnostic"
    )
}

impl Drop for Requests {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

/// Cancellation answers immediately; the worker stops between documents.
async fn compute(
    request: Request,
    context: Context,
    snapshot: Snapshot,
    start: Start,
) -> HandlerResult {
    let pause = match start {
        Start::Settled(value) => return HandlerResult::Ok(value),
        Start::After(pause) => pause,
        Start::Now => std::time::Duration::ZERO,
    };
    // An editor request's own failure reaches the user as it is.
    let rename = request.method == "textDocument/rename"
        || crate::semantic::requests::handles(&request.method);
    let cancel = snapshot.cancel.clone();
    let worker = async move {
        tokio::time::sleep(pause).await;
        tokio::task::spawn_blocking(move || analyze(request, &context, &snapshot)).await
    };
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(Interrupted::Cancelled.into()),
        result = worker => result.map_err(anyhow::Error::from).and_then(std::convert::identity),
    };
    match result {
        Ok(value) => HandlerResult::Ok(value),
        Err(error) if rename && !error.is::<Interrupted>() => {
            HandlerResult::Err(JsonRpcError::new(-32603, format!("{error:#}")))
        }
        Err(error) => HandlerResult::Err(rpc_error(&error)),
    }
}

/// Execute compiler pulls outside the foreground protocol loop.
fn analyze(request: Request, context: &Context, snapshot: &Snapshot) -> Result<Value> {
    tracing::debug!(method = request.method, "Request started");
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
        document_request(request, context, snapshot)
    }?;
    snapshot.check()?;
    Ok(result)
}

/// Compiler-backed editor work shares the same lifetime and stays off the input loop.
fn document_request(request: Request, context: &Context, snapshot: &Snapshot) -> Result<Value> {
    if request.method == "textDocument/rename" {
        let uri = serde_json::from_value::<lsp_types::RenameParams>(request.params.clone())?
            .text_document_position
            .text_document
            .uri;
        let [fsharp, csharp] = context.engines.each_ref().map(Option::as_ref);
        let (primary, fallback) =
            crate::dispatch::pick_sidecar_with_fallback(&request, csharp, fsharp);
        let value = crate::semantic::rename::handle_rename(
            request,
            &context.runtime,
            primary,
            fallback,
            snapshot.cancellation(),
        )?;
        crate::diagnostic_publish::converge_provisional_publication(
            Some(&uri),
            &context.runtime,
            csharp,
            fsharp,
            &context.sender,
        );
        Ok(value)
    } else if request.method == "textDocument/codeLens" {
        let [fsharp, csharp] = context.engines.each_ref().map(Option::as_ref);
        let sidecar = crate::dispatch::pick_sidecar(&request, csharp, fsharp);
        crate::code_lens::handle_code_lens(
            request,
            &context.runtime,
            sidecar,
            snapshot.cancellation(),
            &context.sender,
        )
    } else if crate::semantic::requests::handles(&request.method) {
        crate::semantic::requests::answer(
            request,
            context.engines.each_ref().map(Option::as_ref),
            &context.vfs,
            &context.runtime,
            snapshot.cancellation(),
            &context.sender,
            &|token, value| snapshot.progress(token, value),
        )
    } else {
        super::handle_document_diagnostic(request, &context.vfs, snapshot)
    }
}

/// Preserve protocol cancellation and request-error semantics at the adapter boundary.
fn rpc_error(error: &anyhow::Error) -> JsonRpcError {
    let interrupted = error.downcast_ref::<Interrupted>();
    tracing::debug!(?interrupted, "Diagnostic request rejected");
    match interrupted {
        Some(Interrupted::Cancelled) => JsonRpcError::new(-32800, "Request cancelled"),
        // Stable compiler-input failures retain their actionable cause. [DIAG-TRUTH-GUARANTEES]
        _ if compiler_inputs_unavailable(error) => JsonRpcError::new(-32603, error.to_string()),
        _ if settled_refusal(error) => refused(error),
        _ if error.downcast_ref::<serde_json::Error>().is_some() => {
            JsonRpcError::new(-32602, "Invalid diagnostic parameters")
        }
        // A preempted lens is retryable exactly like superseded work, and says
        // why it was cancelled. [SHARPLSP-FEATURES-CODE-LENS]
        _ if error.is::<crate::code_lens::LensPreempted>() => {
            JsonRpcError::new(-32802, crate::code_lens::LensPreempted.to_string())
                .with_data(json!({"retriggerRequest": true}))
        }
        _ => JsonRpcError::new(-32802, "Diagnostic snapshot unavailable or superseded")
            .with_data(json!({"retriggerRequest": true})),
    }
}

/// The compiler's own message, when an analysis failed because the compiler
/// answered with an error: not a superseded request, a timeout or a broken
/// transport. The shared store keeps failures as text. [DIAG-TRUTH-GUARANTEES]
fn compiler_refusal(error: &anyhow::Error) -> Option<&str> {
    let Some(PullError::Analysis(AnalysisError(message))) = error.downcast_ref::<PullError>()
    else {
        return None;
    };
    message
        .strip_prefix(crate::diagnostics::DIAGNOSTICS_REQUEST)?
        .strip_prefix(": ")?
        .strip_prefix(CompilerRefusal::PREFIX)
}

/// Unavailable SDK inputs fail a pull loudly, with their actionable cause. [DIAG-TRUTH-GUARANTEES]
fn compiler_inputs_unavailable(error: &anyhow::Error) -> bool {
    compiler_refusal(error)
        .is_some_and(|cause| cause.starts_with("SDK compiler inputs unavailable: "))
}

/// Any other refusal is settled for the current inputs: asking again cannot
/// change the answer until the workspace changes, and that change refreshes.
/// VS Code asked again at once whenever it was told it could, 165,000 times in
/// thirteen minutes for one document outside every project (#527).
/// A refusal while a selected solution still loads is about the inputs being
/// replaced, so it stays retryable.
pub(super) fn settled_refusal(error: &anyhow::Error) -> bool {
    compiler_refusal(error).is_some()
        && !compiler_inputs_unavailable(error)
        && !super::state::loading()
}

/// Server-cancelled with the compiler's cause and no retrigger: the editor keeps
/// what it showed, never an empty report, and asks again on the next refresh.
fn refused(error: &anyhow::Error) -> JsonRpcError {
    JsonRpcError::new(-32802, error.to_string()).with_data(json!({"retriggerRequest": false}))
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

/// Validate the input epoch at the serialized output boundary as well. A report
/// or refusal computed for replaced inputs is superseded, never settled; only a
/// client cancellation keeps its own answer. [DIAG-TRUTH-GUARANTEES]
fn current(result: HandlerResult, store: &PullStore, revision: Option<u64>) -> HandlerResult {
    let cancelled = matches!(&result, HandlerResult::Err(error) if error.code == -32800);
    if !cancelled && revision.is_some_and(|revision| store.revision() != revision) {
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
