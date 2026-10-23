//! Compiler-originated invalidation. Implements [DIAG-IPC-REFRESH].

use std::sync::Arc;

use lsp_server::{Message, Notification};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;

/// Wire both engines' idle notification readers before workspace initialization.
pub fn start(
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    runtime: &tokio::runtime::Runtime,
    sender: &crossbeam_channel::Sender<Message>,
) {
    for sidecar in sidecars.into_iter().flatten() {
        let Some(mut notifications) = sidecar.take_notification_receiver() else {
            continue;
        };
        let sender = sender.clone();
        drop(runtime.spawn(async move {
            while let Some(notification) = notifications.recv().await {
                if let Err(error) = refresh(notification.method.as_deref(), &sender) {
                    warn!(%error, "Sidecar diagnostic event failed");
                }
            }
        }));
    }
}

/// Diagnostic values stay in the query; notifications only mutate its inputs.
fn refresh(
    method: Option<&str>,
    sender: &crossbeam_channel::Sender<Message>,
) -> anyhow::Result<()> {
    match method {
        Some("diagnostics/refresh") => {
            super::state::engine_changed();
            Ok(())
        }
        Some("workspace/initializationComplete") => {
            let notification = Notification::new(
                "workspace/projectInitializationComplete".to_owned(),
                serde_json::Value::Null,
            );
            sender.send(Message::Notification(notification))?;
            super::state::engine_changed();
            Ok(())
        }
        _ => Ok(()),
    }
}
