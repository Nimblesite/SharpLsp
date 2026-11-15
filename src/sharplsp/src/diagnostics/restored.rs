//! Republishing a project's diagnostics once its restore has run the `NuGet`
//! audit. Implements [PKG-VULN-DIAG].

use std::sync::Arc;

use lsp_server::Message;
use tracing::warn;

use crate::sidecar::manager::SidecarManager;

/// Republish a restored `MSBuild` file's diagnostics because its audit ran
/// during the restore: host-owned props files publish the vulnerability set
/// directly, project files re-request through their `owner` sidecar with the
/// `NuGet` findings appended. Implements [PKG-VULN-DIAG].
/// Never-opened documents (no push generation) are left to their next open.
pub(crate) fn publish_after_restore(
    runtime: &tokio::runtime::Handle,
    sender: &crossbeam_channel::Sender<Message>,
    owner: Option<&Arc<SidecarManager>>,
    file_path: &str,
) {
    let Ok(uri) = crate::paths::path_to_lsp_uri(file_path) else {
        return;
    };
    if super::current_generation(&uri).is_none() {
        return;
    }
    if crate::nuget::vulnerability::owns_document(file_path) {
        let generation = super::next_generation(&uri);
        let path = file_path.to_string();
        let sender = sender.clone();
        drop(runtime.spawn(async move {
            let diagnostics = crate::nuget::vulnerability::document_diagnostics(&path).await;
            if let Err(err) = super::publish_if_current(&sender, &uri, generation, diagnostics) {
                warn!("Failed to republish restored diagnostics: {err:#}");
            }
        }));
    } else if let Some(sidecar) =
        owner.filter(|_| crate::nuget::vulnerability::appends_to_sidecar(file_path))
    {
        super::request_in_background(
            runtime,
            Arc::clone(sidecar),
            sender.clone(),
            uri,
            file_path.to_string(),
        );
    }
}
