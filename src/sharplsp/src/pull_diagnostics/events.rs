//! Compiler-originated invalidation. Implements [DIAG-IPC-REFRESH].

use std::sync::Arc;

use lsp_server::{Message, Notification};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// Wire both engines' idle notification readers before workspace initialization.
/// `sidecars` are the F# and then the C# engine.
pub fn start(
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    runtime: &tokio::runtime::Runtime,
    sender: &crossbeam_channel::Sender<Message>,
    vfs: &Arc<Vfs>,
) {
    for (sidecar, fsharp) in sidecars.into_iter().zip([true, false]) {
        let Some(sidecar) = sidecar else { continue };
        let Some(mut notifications) = sidecar.take_notification_receiver() else {
            continue;
        };
        let (sender, sidecar, vfs) = (sender.clone(), Arc::clone(sidecar), Arc::clone(vfs));
        drop(runtime.spawn(async move {
            while let Some(notification) = notifications.recv().await {
                let method = notification.method.as_deref();
                if let Err(error) = refresh(method, &sender) {
                    warn!(%error, "Sidecar diagnostic event failed");
                }
                if method == Some("diagnostics/refresh") {
                    republish(&sidecar, fsharp, &sender, &vfs);
                }
            }
        }));
    }
}

/// Push clients have no refresh request: the documents the compiler lists are
/// reconciled with what was published for them. [SCRIPT-RELOAD-CLOSURE]
fn republish(
    sidecar: &Arc<SidecarManager>,
    fsharp: bool,
    sender: &crossbeam_channel::Sender<Message>,
    vfs: &Arc<Vfs>,
) {
    if super::state::is_pull() {
        return;
    }
    let (sender, sidecar, vfs) = (sender.clone(), Arc::clone(sidecar), Arc::clone(vfs));
    drop(tokio::spawn(async move {
        if let Err(error) = crate::diagnostics::reconcile(&sidecar, fsharp, &sender, &vfs).await {
            warn!(%error, "Published diagnostics not reconciled");
        }
    }));
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
            super::state::engine_loaded();
            Ok(())
        }
        _ => Ok(()),
    }
}
