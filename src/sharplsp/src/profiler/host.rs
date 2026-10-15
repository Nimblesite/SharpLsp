//! Mounts the shared profiler in the `SharpLsp` host. Implements
//! [PROFILER-SHARED-LIBRARY-HOST].
//!
//! The library owns every profiling decision; this module only routes
//! `workspace/executeCommand` requests under the `sharplsp.lspProfiler.*`
//! prefix to [`ProfilerService`], answers with the protocol's JSON-RPC error
//! codes, forwards the service's notifications to the client, and honours
//! `$/cancelRequest` while an operation is in flight.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use lsp_profiler::commands;
use lsp_profiler::{ProfilerConfig, ProfilerEvents, ProfilerService};
use lsp_profiler_dotnet::{DotNetConfig, DotNetRuntime};
use lsp_server::{Message, Notification, Request, RequestId, Response};
use serde_json::Value;
use tokio::sync::oneshot;
use tracing::{info, warn};

/// The host prefix of every profiler command: `sharplsp.lspProfiler.<area>.<action>`.
pub const COMMAND_PREFIX: &str = "sharplsp";

/// JSON-RPC code of a cancelled request.
const REQUEST_CANCELLED: i32 = -32800;

/// Forwards the service's notifications to the editor.
#[derive(Debug)]
struct Events {
    /// The LSP connection's outbound channel.
    sender: crossbeam_channel::Sender<Message>,
}

#[async_trait]
impl ProfilerEvents for Events {
    async fn notify(&self, method: &'static str, params: Value) {
        let notification = Notification::new(method.to_owned(), params);
        if self
            .sender
            .send(Message::Notification(notification))
            .is_err()
        {
            warn!(method, "profiler notification dropped: connection closed");
        }
    }
}

/// The mounted profiler: one service for the server's lifetime.
pub struct ProfilerHost {
    /// The shared service; cloned into every in-flight request task.
    service: Arc<ProfilerService>,
    /// Cancellation senders of in-flight requests, pruned as they finish.
    pending: HashMap<RequestId, oneshot::Sender<()>>,
}

impl ProfilerHost {
    /// Mount the shared profiler with the .NET runtime, keeping artifacts under
    /// `config.output_directory` resolved against `root`.
    pub fn mount(
        root: &std::path::Path,
        config: &crate::config::ProfilerConfig,
        sender: crossbeam_channel::Sender<Message>,
        runtime: &tokio::runtime::Runtime,
    ) -> Self {
        Self::new(root.join(&config.output_directory), sender, runtime)
    }

    /// Mount the shared profiler with the .NET runtime, keeping artifacts under `output_dir`.
    pub fn new(
        output_dir: PathBuf,
        sender: crossbeam_channel::Sender<Message>,
        runtime: &tokio::runtime::Runtime,
    ) -> Self {
        let dotnet = DotNetRuntime::new(DotNetConfig {
            engine: crate::paths::profiler_engine_path(),
            output_dir: output_dir.clone(),
        });
        let config = ProfilerConfig {
            output_dir,
            ..ProfilerConfig::default()
        };
        let service = runtime.block_on(async move {
            ProfilerService::new(vec![Arc::new(dotnet)], config, Arc::new(Events { sender }))
        });
        info!(
            "profiler mounted: {} commands",
            commands::command_names(COMMAND_PREFIX).len()
        );
        Self {
            service: Arc::new(service),
            pending: HashMap::new(),
        }
    }

    /// Every `workspace/executeCommand` name the server advertises for the profiler.
    pub fn command_names() -> Vec<String> {
        commands::command_names(COMMAND_PREFIX)
    }

    /// Route a profiler `workspace/executeCommand`; false when `req` is not one.
    pub fn dispatch(
        &mut self,
        req: &Request,
        runtime: &tokio::runtime::Runtime,
        sender: &crossbeam_channel::Sender<Message>,
    ) -> bool {
        if req.method != "workspace/executeCommand" {
            return false;
        }
        let Some((method, params)) = profiler_call(&req.params) else {
            return false;
        };
        self.pending.retain(|_, cancel| !cancel.is_closed());
        let (cancel, cancelled) = oneshot::channel();
        let _ = self.pending.insert(req.id.clone(), cancel);
        let service = Arc::clone(&self.service);
        let (id, sender) = (req.id.clone(), sender.clone());
        drop(runtime.spawn(complete(service, id, method, params, cancelled, sender)));
        true
    }

    /// Consume a `$/cancelRequest`; unknown and completed IDs are harmless.
    pub fn cancel(&mut self, params: &Value) {
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

    /// Stop every session before the sidecars go down.
    pub fn shutdown(&self, runtime: &tokio::runtime::Runtime) {
        runtime.block_on(self.service.shutdown());
    }
}

/// The `experimental.lspProfiler` capability block: every runtime this host mounts.
/// Built from the runtime descriptions alone, so it is available before the
/// service exists (capabilities are answered before the tokio runtime starts).
pub fn capability_block() -> Value {
    use lsp_profiler::runtime::Runtime;
    let dotnet = DotNetRuntime::new(DotNetConfig::default());
    serde_json::json!({ "runtimes": [dotnet.info()] })
}

/// The protocol method and its parameters when `params` is a profiler command.
fn profiler_call(params: &Value) -> Option<(&'static str, Value)> {
    let command = params.get("command")?.as_str()?;
    let method = commands::method_for(COMMAND_PREFIX, command)?;
    let arguments = params
        .get("arguments")
        .and_then(Value::as_array)
        .and_then(|args| args.first().cloned())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    Some((method, arguments))
}

/// Emit exactly one response after completion or cancellation.
async fn complete(
    service: Arc<ProfilerService>,
    id: RequestId,
    method: &'static str,
    params: Value,
    mut cancelled: oneshot::Receiver<()>,
    sender: crossbeam_channel::Sender<Message>,
) {
    let started = std::time::Instant::now();
    let response = tokio::select! {
        biased;
        _ = &mut cancelled => Response::new_err(id, REQUEST_CANCELLED, "profiler operation cancelled".to_owned()),
        result = service.handle(method, params) => match result {
            Ok(value) => Response::new_ok(id, value),
            Err(error) => {
                let code = i32::try_from(error.code()).unwrap_or(-32000);
                Response::new_err(id, code, error.to_string())
            }
        },
    };
    info!(
        method,
        ms = started.elapsed().as_millis(),
        "profiler request finished"
    );
    if sender.send(Message::Response(response)).is_err() {
        warn!(method, "profiler response dropped: connection closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiler_commands_are_recognised_with_their_first_argument() {
        let params = serde_json::json!({ "command": "sharplsp.lspProfiler.cpu.start", "arguments": [{ "pid": 7 }] });
        let (method, args) = profiler_call(&params).unwrap_or(("", Value::Null));
        assert_eq!(method, "lspProfiler/cpu/start");
        assert_eq!(args.get("pid"), Some(&Value::from(7)));
    }

    #[test]
    fn other_commands_are_left_to_the_server() {
        assert!(profiler_call(&serde_json::json!({ "command": "sharplsp.build" })).is_none());
        assert!(
            profiler_call(&serde_json::json!({ "command": "basilisk.lspProfiler.cpu.start" }))
                .is_none()
        );
    }

    #[test]
    fn a_missing_argument_list_becomes_empty_params() {
        let params = serde_json::json!({ "command": "sharplsp.lspProfiler.capabilities" });
        let (_, args) = profiler_call(&params).unwrap_or(("", Value::Null));
        assert!(args.as_object().is_some_and(serde_json::Map::is_empty));
    }
}
