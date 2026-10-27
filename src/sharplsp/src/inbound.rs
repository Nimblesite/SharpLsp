//! Inbound message routing for the main LSP loop — the shutdown fast path and
//! diagnostic request wiring. Implements [SHARPLSP-ARCHITECTURE-TIERS].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::{Connection, Message, Notification, Response};
use lsp_types::request::{Request as _, Shutdown};
use tracing::{info, warn};

use crate::pull_diagnostics;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// The loop-internal marker that stands in for a `shutdown` the fast path
/// has already answered.
pub(crate) const SHUTDOWN_ANSWERED: &str = "sharplsp/shutdownAnswered";

/// Mount diagnostic request work separately from the foreground LSP loop.
pub(crate) fn diagnostic_requests(
    runtime: &tokio::runtime::Runtime,
    engines: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Arc<Vfs>,
    connection: &Connection,
) -> pull_diagnostics::requests::Requests {
    pull_diagnostics::requests::Requests::new(runtime, engines, vfs, connection.sender.clone())
}

/// Answer `shutdown` the moment it arrives, ahead of whatever the loop is
/// busy with. Implements [SHARPLSP-ARCHITECTURE-TIERS].
///
/// The loop dispatches one message at a time and a semantic request holds it
/// for the sidecar's whole round trip, so a `shutdown` queued behind one waited
/// that long. vscode-languageclient gives a server two seconds to answer before
/// it declares the stop failed and abandons the restart the user asked for —
/// on a Windows agent an F# check ran past that and left the client dead.
/// LSP 3.17 asks the server to answer `shutdown` and accept no further work;
/// the answer does not have to wait for work already in flight. This thread
/// reads the client stream ahead of the loop, answers `shutdown` itself, and
/// hands the loop [`SHUTDOWN_ANSWERED`] in its place so the loop still refuses
/// everything that follows.
pub(crate) fn inbound_with_inputs(
    connection: &Connection,
    cancellation: lspkit_server::CancellationHandle,
) -> Result<crossbeam_channel::Receiver<Message>> {
    let (inbound, inputs) = spawn_shutdown_fast_path(connection, cancellation.clone());
    pull_diagnostics::state::connect_inputs(inputs, cancellation)?;
    Ok(inbound)
}

/// Read client messages while the foreground handler is occupied.
fn spawn_shutdown_fast_path(
    connection: &Connection,
    cancellation: lspkit_server::CancellationHandle,
) -> (
    crossbeam_channel::Receiver<Message>,
    crossbeam_channel::Sender<Message>,
) {
    let (to_loop, from_client) = crossbeam_channel::unbounded();
    let inbound = connection.receiver.clone();
    let outbound = connection.sender.clone();
    let inputs = to_loop.clone();
    // The thread ends with the client stream; nothing waits on it.
    drop(std::thread::spawn(move || {
        for msg in &inbound {
            // [DIAG-ANALYSIS-CANCELLATION] A queued edit may wait for this request's IPC.
            if let Message::Request(request) = &msg {
                if let Err(error) =
                    pull_diagnostics::requests::Requests::observe(&cancellation, request)
                {
                    warn!(%error, "Diagnostic request interest unavailable");
                }
            }
            if let Message::Notification(notification) = &msg {
                pull_diagnostics::requests::Requests::changed(&cancellation, notification);
                if notification.method == "$/cancelRequest" {
                    cancellation.cancel_request(&notification.params);
                }
            }
            let forwarded = match msg {
                Message::Request(req) if req.method == Shutdown::METHOD => {
                    info!("Shutdown request received");
                    let resp = Response::new_ok(req.id, serde_json::Value::Null);
                    if outbound.send(Message::Response(resp)).is_err() {
                        break;
                    }
                    Message::Notification(Notification::new(
                        SHUTDOWN_ANSWERED.to_string(),
                        serde_json::Value::Null,
                    ))
                }
                other => other,
            };
            if to_loop.send(forwarded).is_err() {
                break;
            }
        }
        // [SHARPLSP-ARCHITECTURE-TIERS] Input watchers retain the queue sender after EOF.
        // End the protocol explicitly rather than waiting for their senders to drop.
        let exit = Notification::new("exit".to_string(), serde_json::Value::Null);
        let _closed = to_loop.send(Message::Notification(exit));
    }));
    (from_client, inputs)
}
