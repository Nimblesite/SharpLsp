//! Diagnostic publication orchestration — selecting the owning sidecar for a
//! document and refreshing, converging, and republishing diagnostics on the
//! push path. Implements [NETFX-CONTEXT].

use std::sync::Arc;

use lsp_server::Connection;
use lsp_types::Uri;
use tracing::warn;

use crate::diagnostics;
use crate::paths;
use crate::pull_diagnostics;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::LangId;
use crate::vfs::Vfs;

/// Select the sidecar that owns a document, by file language. F# documents go to
/// the F# sidecar; everything else (including unknown extensions) to C#.
pub(crate) fn sidecar_for_uri<'a>(
    uri: &Uri,
    csharp: Option<&'a Arc<SidecarManager>>,
    fsharp: Option<&'a Arc<SidecarManager>>,
) -> Option<&'a Arc<SidecarManager>> {
    match LangId::from_uri(uri) {
        Some(LangId::FSharp) => fsharp,
        _ => csharp,
    }
}

/// Re-fetch and republish a document's diagnostics before a semantic response
/// is sent, while the latest publication is still a provisional tier-2
/// placeholder. On the serialized sidecar transport this fetch runs strictly
/// after the request that produced the semantic answer, so the corrected
/// diagnostic set always precedes a tier-1-revealing answer on the client
/// stream. [SCRIPT-FILEBASED-REFERENCES-FALLBACK], [DIAG-PUSH-GATE]
pub(crate) fn converge_provisional_publication(
    uri: Option<&Uri>,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
) {
    let Some(uri) = uri else { return };
    if !diagnostics::published_set_is_provisional(uri) {
        return;
    }
    let Some(sidecar) = sidecar_for_uri(uri, csharp_sidecar, fsharp_sidecar) else {
        return;
    };
    let Ok(file_path) = paths::uri_to_path(uri.as_str()) else {
        return;
    };
    runtime.block_on(diagnostics::converge_provisional(
        sidecar,
        &connection.sender,
        uri,
        &file_path,
    ));
}

/// Re-publish every open document's diagnostics, returning once each is out: a
/// framework switch changes which `#if` branches compile, and the editor hears
/// of the switch only after them. [NETFX-CONTEXT]
pub(crate) fn republish_open_diagnostics(
    vfs: &Vfs,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
) {
    if pull_diagnostics::state::is_pull() {
        if let Err(error) = pull_diagnostics::state::invalidate() {
            warn!(%error, "Framework diagnostic refresh failed");
        }
        return;
    }
    let open = vfs
        .iter()
        .filter_map(|entry| push_target(entry.key(), csharp_sidecar, fsharp_sidecar))
        .collect();
    diagnostics::publish_now(runtime, open, &connection.sender);
}

/// Where a document's diagnostics come from: the sidecar its language routes
/// to, and its native path.
fn push_target(
    uri: &Uri,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Option<diagnostics::PushTarget> {
    let sidecar = sidecar_for_uri(uri, csharp_sidecar, fsharp_sidecar)?;
    let file_path = paths::uri_to_path(uri.as_str()).ok()?;
    Some((Arc::clone(sidecar), uri.clone(), file_path))
}

/// Spawn a background diagnostic request for the given URI.
///
/// Routes to the correct sidecar based on the document's language.
pub(crate) fn trigger_diagnostics(
    uri: &Uri,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
    fsharp_sidecar: Option<&Arc<SidecarManager>>,
    connection: &Connection,
) {
    if pull_diagnostics::state::is_pull() {
        if let Err(error) = pull_diagnostics::state::invalidate() {
            warn!(%error, "Diagnostic dependencies could not be invalidated");
        }
        return;
    }
    let Some((sidecar, uri, file_path)) = push_target(uri, csharp_sidecar, fsharp_sidecar) else {
        return;
    };
    diagnostics::request_in_background(runtime, sidecar, connection.sender.clone(), uri, file_path);
}
