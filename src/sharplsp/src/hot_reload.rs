//! C# hot-reload bridge: JSON-RPC from the editor to `MessagePack` on the sidecar.

use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use serde::{Deserialize, Serialize};

use crate::sidecar::manager::SidecarManager;

/// One start, update, or end operation from the active DAP session.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotReloadParams {
    /// Operation: start, update, or end.
    action: String,
    /// Session identity for update and end.
    session_id: Option<String>,
    /// C# project whose built output forms the baseline.
    project_path: Option<String>,
    /// Changed source file for update.
    file_path: Option<String>,
    /// Complete saved source text for update.
    new_text: Option<String>,
    /// Capabilities reported by the debug runtime.
    capabilities: Option<Vec<String>>,
    /// Saved documents included in one atomic update batch.
    documents: Option<Vec<HotReloadDocument>>,
}

/// One saved source document in a batched update.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotReloadDocument {
    /// Absolute path of the changed source file.
    file_path: String,
    /// Complete saved source text.
    new_text: String,
}

/// One runtime-applicable Roslyn delta.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotReloadDelta {
    /// Module version id identifying the loaded assembly.
    module_id: String,
    /// Base64-encoded metadata delta.
    metadata_delta: String,
    /// Base64-encoded IL delta.
    il_delta: String,
    /// Base64-encoded portable-PDB delta.
    pdb_delta: String,
}

/// Sidecar result returned to the DAP router.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HotReloadResponse {
    /// Result state such as applied or restartRequired.
    status: String,
    /// Stable sidecar session id.
    session_id: String,
    /// Assembly name used to locate the loaded runtime assembly.
    assembly_name: String,
    /// Deltas ready for `MetadataUpdater.ApplyUpdate`.
    updates: Vec<HotReloadDelta>,
    /// Named compiler or rude-edit diagnostics.
    diagnostics: Vec<String>,
}

/// Forward `sharplsp/hotReload` to the C# sidecar without changing its payload.
pub fn handle(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    csharp_sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let sidecar = csharp_sidecar.context("sharplsp/hotReload requires the C# sidecar")?;
    let params: HotReloadParams = serde_json::from_value(req.params)?;
    let payload = rmp_serde::to_vec(&params).context("serialize hot reload request")?;
    let bytes = runtime
        .block_on(sidecar.request("debug/hotReload", payload))
        .context("C# sidecar hot reload request")?;
    let response: HotReloadResponse =
        rmp_serde::from_slice(&bytes).context("decode hot reload response")?;
    Ok(serde_json::to_value(response)?)
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::panic,
        reason = "test code — a serialization contract violation must fail the test"
    )]

    use super::*;

    /// Positional wire representation required by the C# integer keys.
    type RequestWire = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Vec<String>>,
        Option<Vec<(String, String)>>,
    );

    #[test]
    fn request_uses_csharp_messagepack_key_order() {
        let request = HotReloadParams {
            action: "update".into(),
            session_id: Some("session".into()),
            project_path: Some("App.csproj".into()),
            file_path: Some("Program.cs".into()),
            new_text: Some("class C {}".into()),
            capabilities: Some(vec!["Baseline".into()]),
            documents: Some(vec![HotReloadDocument {
                file_path: "Other.cs".into(),
                new_text: "class Other {}".into(),
            }]),
        };

        let Ok(bytes) = rmp_serde::to_vec(&request) else {
            panic!("request must serialize");
        };
        let Ok(decoded) = rmp_serde::from_slice::<RequestWire>(&bytes) else {
            panic!("request tuple must decode");
        };

        assert_eq!(decoded.0, "update");
        assert_eq!(decoded.1.as_deref(), Some("session"));
        assert_eq!(decoded.2.as_deref(), Some("App.csproj"));
        assert_eq!(decoded.3.as_deref(), Some("Program.cs"));
        assert_eq!(decoded.4.as_deref(), Some("class C {}"));
        assert_eq!(decoded.5, Some(vec!["Baseline".into()]));
        assert_eq!(
            decoded.6,
            Some(vec![("Other.cs".into(), "class Other {}".into())])
        );
    }

    #[test]
    fn response_becomes_camel_case_json() {
        let Ok(bytes) = rmp_serde::to_vec(&(
            "applied",
            "session",
            "App",
            vec![("module", "metadata", "il", "pdb")],
            Vec::<String>::new(),
        )) else {
            panic!("response tuple must serialize");
        };
        let Ok(response) = rmp_serde::from_slice::<HotReloadResponse>(&bytes) else {
            panic!("response must decode");
        };
        let Ok(json) = serde_json::to_value(response) else {
            panic!("response JSON must encode");
        };

        assert_eq!(json.get("sessionId"), Some(&serde_json::json!("session")));
        assert_eq!(json.get("assemblyName"), Some(&serde_json::json!("App")));
        let Some(delta) = json
            .get("updates")
            .and_then(serde_json::Value::as_array)
            .and_then(|updates| updates.first())
        else {
            panic!("one update must exist");
        };
        assert_eq!(
            delta.get("metadataDelta"),
            Some(&serde_json::json!("metadata"))
        );
        assert!(json
            .get("diagnostics")
            .and_then(serde_json::Value::as_array)
            .is_some_and(Vec::is_empty));
    }
}
