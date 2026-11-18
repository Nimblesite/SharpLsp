//! Push clients: the files a compiler lists changed, as when a file-based
//! app's root gains or drops an `#:include`. What was published for a file
//! that left is cleared, and a file that entered is published.
//! Implements [SCRIPT-RELOAD-CLOSURE].

use std::collections::HashSet;

use anyhow::Result;
use lsp_server::Message;
use lsp_types::Uri;

use super::gate;
use crate::paths;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

/// The tracked document `uri` when `sidecar`'s compiler no longer lists it and
/// the editor does not hold it open: an open document answers for itself.
fn left(uri: &str, fsharp: bool, listed: &HashSet<String>, vfs: &Vfs) -> Option<Uri> {
    let path = paths::uri_to_path(uri).ok()?;
    let owned = paths::is_fsharp_diagnostic_input(&path) == fsharp;
    let gone = !listed.contains(&paths::comparison_key(&path));
    let closed = vfs.get_content_for_path_canonical(&path).is_none();
    (owned && gone && closed)
        .then(|| paths::path_to_lsp_uri(&path).ok())
        .flatten()
}

/// Bring what is published in line with the documents `sidecar` lists now.
/// `fsharp` says which language's documents it owns.
///
/// # Errors
/// The compiler could not list its documents, or the client is gone.
pub async fn reconcile(
    sidecar: &SidecarManager,
    fsharp: bool,
    sender: &crossbeam_channel::Sender<Message>,
    vfs: &Vfs,
) -> Result<()> {
    let config = crate::pull_diagnostics::state::configuration()?;
    let filter = &config.project_filter;
    let listed = crate::pull_diagnostics::paths_for_sidecar(sidecar, filter).await?;
    let keys: HashSet<String> = listed
        .iter()
        .map(|path| paths::comparison_key(path))
        .collect();
    for uri in gate::tracked() {
        if let Some(uri) = left(&uri, fsharp, &keys, vfs) {
            super::clear(sender, uri)?;
        }
    }
    let entered = listed.iter().filter(|_| config.solution_wide_analysis);
    for path in entered {
        let uri = paths::path_to_lsp_uri(path)?;
        if gate::current_generation(&uri).is_none() {
            super::publish_entered(sidecar, sender, &uri, path).await;
        }
    }
    Ok(())
}
