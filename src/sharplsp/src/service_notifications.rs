//! The notifications the main loop routes to the connection's services rather
//! than to a document: build watching, cancellation, configuration changes and
//! watched files. Implements [SHARPLSP-ARCHITECTURE-TIERS] and [CONFIG-RESOLUTION-LIVE].
use std::sync::Arc;

use crossbeam_channel::Sender;
use lsp_server::{Message, Notification};
use tracing::warn;

use crate::build_monitor::handle_build_watch;
use crate::configuration_live::{self, Compilers, CONFIGURATION_FILES_CHANGED};
use crate::pull_diagnostics;
use crate::vfs::Vfs;
use crate::HostServices;

/// Route `notif` to the service it belongs to, and give it back when it is not a service's.
pub(crate) fn route(
    notif: Notification,
    services: &mut HostServices,
    diagnostic_requests: &pull_diagnostics::requests::Requests,
    compilers: Compilers<'_>,
    vfs: &Arc<Vfs>,
    runtime: &tokio::runtime::Runtime,
    client: &Sender<Message>,
) -> Option<Notification> {
    if handle_build_watch(&notif, services, runtime, client) {
        return None;
    }
    match notif.method.as_str() {
        "$/cancelRequest" => {
            diagnostic_requests.cancel(&notif.params);
            services.profiler.cancel(&notif.params);
        }
        "workspace/didChangeConfiguration" => {
            configuration_live::settings_changed(
                services,
                &notif.params,
                compilers,
                vfs,
                runtime,
                client,
            );
        }
        CONFIGURATION_FILES_CHANGED => {
            configuration_live::reconfigure(services, compilers, vfs, runtime, client);
        }
        "workspace/didChangeWatchedFiles" => watched_files(notif, compilers, vfs, runtime, client),
        _ => return Some(notif),
    }
    None
}

/// Feed changed files to the compilers' diagnostic inputs.
fn watched_files(
    notif: Notification,
    compilers: Compilers<'_>,
    vfs: &Arc<Vfs>,
    runtime: &tokio::runtime::Runtime,
    client: &Sender<Message>,
) {
    if let Err(error) =
        pull_diagnostics::changes::watched(notif.params, runtime, compilers, vfs, client)
    {
        warn!(%error, "Diagnostic input update failed");
    }
}
