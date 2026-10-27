//! Input observation retains no versions or diagnostic results. [DIAG-ANALYSIS-CANCELLATION]
use lsp_server::{Notification, Request};
use lsp_types::{CodeLensParams, DocumentDiagnosticParams, Uri};
use lspkit_server::{CancellationHandle, RequestInterest};

use crate::paths;

/// Standard method for connection-wide solution diagnostics.
const WORKSPACE: &str = "workspace/diagnostic";
/// A connection-wide logical scope; document scopes always use canonical native keys.
const WORKSPACE_RESOURCE: &str = "";

/// Register document identity or the connection-wide workspace scope before scheduling.
pub(super) fn request(request: &Request) -> Option<RequestInterest> {
    let (key, input) = if request.method == WORKSPACE {
        (WORKSPACE_RESOURCE.to_owned(), None)
    } else {
        let (uri, input) = document_input(request)?;
        (resource(&uri)?, input)
    };
    Some(RequestInterest {
        method: request.method.clone(),
        resource: key,
        input,
    })
}

/// Every compiler-backed document request participates in actual source invalidation.
fn document_input(request: &Request) -> Option<(Uri, Option<String>)> {
    match request.method.as_str() {
        "textDocument/diagnostic" => {
            serde_json::from_value::<DocumentDiagnosticParams>(request.params.clone())
                .ok()
                .map(|params| (params.text_document.uri, params.previous_result_id))
        }
        "textDocument/codeLens" => serde_json::from_value::<CodeLensParams>(request.params.clone())
            .ok()
            .map(|params| (params.text_document.uri, None)),
        _ => None,
    }
}

/// Source notifications retire affected work before foreground mutation or compiler IPC.
pub(super) fn changed(cancellation: &CancellationHandle, notification: &Notification) {
    if notification.method == "workspace/didChangeWatchedFiles"
        && crate::pull_diagnostics::changes::needs_rescan(&notification.params)
    {
        cancellation.supersede_all();
        return;
    }
    let Some(key) = change_uri(notification).and_then(|uri| resource(&uri)) else {
        return;
    };
    for method in ["textDocument/diagnostic", "textDocument/codeLens"] {
        cancellation.supersede(method, &key);
    }
    cancellation.supersede(WORKSPACE, WORKSPACE_RESOURCE);
}

/// Inspect only the URI so an ingress reader never copies editor source text.
fn change_uri(notification: &Notification) -> Option<Uri> {
    if matches!(
        notification.method.as_str(),
        "textDocument/didOpen" | "textDocument/didChange" | "textDocument/didClose"
    ) {
        serde_json::from_value(notification.params.pointer("/textDocument/uri")?.clone()).ok()
    } else {
        None
    }
}

/// URI conversion and Windows equality remain in the sole path tier without disk I/O.
fn resource(uri: &Uri) -> Option<String> {
    paths::uri_to_path(uri.as_str())
        .ok()
        .map(|path| paths::comparison_key(&path))
}
