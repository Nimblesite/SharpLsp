//! The active target framework of a multi-targeted project. The editor asks
//! which framework a document's project answers from (`sharplsp/targetFramework`)
//! and switches the WHOLE project (`sharplsp/setTargetFramework`); the owning
//! sidecar keeps the choice. A switch changes every semantic answer about the
//! project, so the editor is told to re-request what it shows.
//! Implements [NETFX-CONTEXT].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use lsp_server::{Message, Notification, Request, RequestId};
use lsp_types::{ClientCapabilities, TextDocumentIdentifier};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::paths;
use crate::sidecar::manager::SidecarManager;

/// The notification that tells the editor a project's framework changed.
pub const CHANGED: &str = "sharplsp/targetFrameworkChanged";

/// Params of both requests: the document, and the framework to switch to.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameworkParams {
    /// A document of the project asked about.
    text_document: TextDocumentIdentifier,
    /// The framework to make active; absent only asks.
    target_framework: Option<String>,
}

/// Wire request: C# `TargetFrameworkRequest` `[Key(0)] FilePath`, `[Key(1)] TargetFramework`.
#[derive(Serialize)]
struct SidecarRequest {
    /// Absolute path of the document.
    file_path: String,
    /// The framework to make active.
    target_framework: Option<String>,
}

/// What both requests answer: C# `TargetFrameworkResult` `[Key(0)] Active`, `[Key(1)] Available`.
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct FrameworkContext {
    /// The framework the project answers from; `null` for a single-target one.
    active: Option<String>,
    /// Every framework, in `<TargetFrameworks>` order; empty when single-target.
    available: Vec<String>,
    /// Absolute path of the project file the answer is about.
    #[serde(default)]
    project: Option<String>,
}

/// The `workspace/*/refresh` requests this client accepts, read once at initialize.
static REFRESHES: OnceLock<Vec<&'static str>> = OnceLock::new();

/// Ids for the refresh requests; the client's replies are ignored.
static NEXT_REFRESH: AtomicU64 = AtomicU64::new(0);

/// Remember which refresh requests the client declared support for.
pub fn remember_client(capabilities: &ClientCapabilities) {
    let _ = REFRESHES.set(refreshes_supported(capabilities));
}

/// The refresh methods whose `refreshSupport` the client declared.
fn refreshes_supported(capabilities: &ClientCapabilities) -> Vec<&'static str> {
    let Some(workspace) = capabilities.workspace.as_ref() else {
        return Vec::new();
    };
    [
        (
            "workspace/semanticTokens/refresh",
            workspace
                .semantic_tokens
                .as_ref()
                .and_then(|c| c.refresh_support),
        ),
        (
            "workspace/inlayHint/refresh",
            workspace
                .inlay_hint
                .as_ref()
                .and_then(|c| c.refresh_support),
        ),
        (
            "workspace/codeLens/refresh",
            workspace.code_lens.as_ref().and_then(|c| c.refresh_support),
        ),
        (
            "workspace/diagnostic/refresh",
            workspace
                .diagnostic
                .as_ref()
                .and_then(|c| c.refresh_support),
        ),
    ]
    .into_iter()
    .filter_map(|(method, supported)| (supported == Some(true)).then_some(method))
    .collect()
}

/// `sharplsp/targetFramework`: the project's active framework and every one it targets.
pub fn handle_get(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: FrameworkParams = serde_json::from_value(req.params)?;
    let context = forward(runtime, sidecar, "workspace/targetFramework", &params)?;
    Ok(serde_json::to_value(context)?)
}

/// `sharplsp/setTargetFramework`: switch the project, then tell the editor.
pub fn handle_set(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    sender: &crossbeam_channel::Sender<Message>,
) -> Result<serde_json::Value> {
    let params: FrameworkParams = serde_json::from_value(req.params)?;
    let framework = params
        .target_framework
        .as_deref()
        .context("sharplsp/setTargetFramework requires targetFramework")?;
    let context = forward(runtime, sidecar, "workspace/setTargetFramework", &params)?;
    info!(uri = %params.text_document.uri.as_str(), framework, "Target framework switched");
    announce(sender, &params.text_document, &context)?;
    Ok(serde_json::to_value(context)?)
}

/// Ask the sidecar that owns the document.
fn forward(
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
    params: &FrameworkParams,
) -> Result<FrameworkContext> {
    let sidecar = sidecar.context("no sidecar owns this document")?;
    let request = SidecarRequest {
        file_path: paths::uri_to_path(params.text_document.uri.as_str())?,
        target_framework: params.target_framework.clone(),
    };
    let payload = rmp_serde::to_vec(&request).context("serialize target framework request")?;
    let bytes = runtime
        .block_on(sidecar.request(method, payload))
        .with_context(|| format!("sidecar {method}"))?;
    rmp_serde::from_slice(&bytes).context("decode target framework result")
}

/// Tell the editor the framework changed, then ask it to re-request what it shows.
fn announce(
    sender: &crossbeam_channel::Sender<Message>,
    document: &TextDocumentIdentifier,
    context: &FrameworkContext,
) -> Result<()> {
    let params = serde_json::json!({
        "textDocument": document,
        "active": context.active,
        "available": context.available,
        "project": context.project,
    });
    sender.send(Message::Notification(Notification::new(
        CHANGED.to_string(),
        params,
    )))?;
    for method in REFRESHES.get().map_or(&[][..], Vec::as_slice) {
        let id = RequestId::from(format!(
            "sharplsp/refresh/{}",
            NEXT_REFRESH.fetch_add(1, Ordering::Relaxed)
        ));
        sender.send(Message::Request(Request::new(
            id,
            (*method).to_string(),
            serde_json::Value::Null,
        )))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::unwrap_used,
        reason = "test code — a serialization contract violation must fail the test"
    )]

    use super::*;

    #[test]
    fn request_uses_csharp_messagepack_key_order() {
        let request = SidecarRequest {
            file_path: "C:/repo/Lib.cs".into(),
            target_framework: Some("net48".into()),
        };
        let bytes = rmp_serde::to_vec(&request).unwrap();
        let wire: (String, Option<String>) = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(
            wire,
            ("C:/repo/Lib.cs".to_string(), Some("net48".to_string()))
        );
    }

    #[test]
    fn result_decodes_positionally_and_answers_null_for_single_target() {
        let bytes = rmp_serde::to_vec(&(None::<String>, Vec::<String>::new())).unwrap();
        let context: FrameworkContext = rmp_serde::from_slice(&bytes).unwrap();
        let json = serde_json::to_value(context).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "active": null, "available": [], "project": null })
        );
    }

    #[test]
    fn result_carries_the_project_in_the_third_key() {
        let wire = (
            Some("net48".to_string()),
            vec!["net48".to_string(), "net8.0".to_string()],
            Some("C:/repo/Lib.csproj".to_string()),
        );
        let bytes = rmp_serde::to_vec(&wire).unwrap();
        let context: FrameworkContext = rmp_serde::from_slice(&bytes).unwrap();
        let json = serde_json::to_value(context).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "active": "net48",
                "available": ["net48", "net8.0"],
                "project": "C:/repo/Lib.csproj",
            })
        );
    }

    #[test]
    fn only_declared_refreshes_are_sent() {
        let capabilities: ClientCapabilities = serde_json::from_value(serde_json::json!({
            "workspace": {
                "semanticTokens": { "refreshSupport": true },
                "inlayHint": { "refreshSupport": false },
                "diagnostic": { "refreshSupport": true }
            }
        }))
        .unwrap();
        assert_eq!(
            refreshes_supported(&capabilities),
            vec![
                "workspace/semanticTokens/refresh",
                "workspace/diagnostic/refresh"
            ]
        );
        assert!(refreshes_supported(&ClientCapabilities::default()).is_empty());
    }
}
