//! Signature help (`textDocument/signatureHelp`).
//!
//! Routed to the language sidecar, which resolves the enclosing method or
//! constructor call and returns its overloads. The F# sidecar (FCS
//! `GetMethods`) implements this; C# requests for which the sidecar has no
//! handler resolve to null. Implements [FS-SIGHELP].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    ParameterInformation, ParameterLabel, SignatureHelp, SignatureHelpParams, SignatureInformation,
};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;
use crate::utils::SidecarPositionReq;

/// Handle `textDocument/signatureHelp` by delegating to the sidecar.
pub fn handle(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: SignatureHelpParams = serde_json::from_value(req.params)?;
    let file_path =
        crate::semantic::uri_to_path(&params.text_document_position_params.text_document.uri)?;
    let pos = params.text_document_position_params.position;

    let request = SidecarPositionReq {
        file_path,
        line: pos.line,
        character: pos.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/signatureHelp", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar signatureHelp unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let result: Option<SidecarSignatureHelp> = rmp_serde::from_slice(&response_bytes)?;
    match result {
        None => Ok(serde_json::Value::Null),
        Some(help) => Ok(serde_json::to_value(map_signature_help(&help))?),
    }
}

/// Convert a sidecar signature-help payload into an LSP [`SignatureHelp`].
fn map_signature_help(help: &SidecarSignatureHelp) -> SignatureHelp {
    let signatures = help.signatures.iter().map(map_signature).collect();
    SignatureHelp {
        signatures,
        active_signature: Some(help.active_signature),
        active_parameter: Some(help.active_parameter),
    }
}

/// Convert one sidecar overload into an LSP [`SignatureInformation`].
fn map_signature(sig: &SidecarSignatureInfo) -> SignatureInformation {
    let parameters = sig
        .parameters
        .iter()
        .map(|label| ParameterInformation {
            label: ParameterLabel::Simple(label.clone()),
            documentation: None,
        })
        .collect();
    SignatureInformation {
        label: sig.label.clone(),
        documentation: None,
        parameters: Some(parameters),
        active_parameter: None,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// Signature-help payload returned by the sidecar. Deserialized from a
/// positional `MessagePack` array matching the sidecar's `SignatureHelpResult`.
#[derive(serde::Deserialize)]
struct SidecarSignatureHelp {
    /// The available overloads.
    signatures: Vec<SidecarSignatureInfo>,
    /// Index of the active overload.
    active_signature: u32,
    /// Index of the active parameter within the active overload.
    active_parameter: u32,
}

/// One overload returned by the sidecar (`SignatureInfoResult`).
#[derive(serde::Deserialize)]
struct SidecarSignatureInfo {
    /// Rendered signature label (e.g. `Greeter(greeting)`).
    label: String,
    /// Parameter labels in declaration order.
    parameters: Vec<String>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn map_signature_help_maps_overloads_and_active_indices() {
        let help = SidecarSignatureHelp {
            signatures: vec![SidecarSignatureInfo {
                label: "Greeter(greeting)".to_string(),
                parameters: vec!["greeting".to_string()],
            }],
            active_signature: 0,
            active_parameter: 0,
        };
        let mapped = map_signature_help(&help);
        assert_eq!(mapped.signatures.len(), 1);
        let first = mapped.signatures.first().unwrap();
        assert_eq!(first.label, "Greeter(greeting)");
        let params = first.parameters.as_ref().unwrap();
        assert_eq!(params.len(), 1);
        assert!(matches!(
            &params.first().unwrap().label,
            ParameterLabel::Simple(text) if text == "greeting"
        ));
        assert_eq!(mapped.active_signature, Some(0));
    }

    #[test]
    fn map_signature_handles_empty_parameter_list() {
        let sig = SidecarSignatureInfo {
            label: "now()".to_string(),
            parameters: vec![],
        };
        let mapped = map_signature(&sig);
        assert_eq!(mapped.label, "now()");
        assert_eq!(mapped.parameters.unwrap().len(), 0);
    }

    #[test]
    fn handle_without_sidecar_returns_null() {
        let req = Request {
            id: lsp_server::RequestId::from(1),
            method: "textDocument/signatureHelp".to_string(),
            params: serde_json::Value::Null,
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let value = handle(req, &runtime, None).unwrap();
        assert_eq!(value, serde_json::Value::Null);
    }
}
