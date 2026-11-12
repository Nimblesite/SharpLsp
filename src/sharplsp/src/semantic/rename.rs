//! Rename through the sidecars: prepare, apply and the cross-language merge.
//! Implements [RENAME-PREPARE], [RENAME-APPLY], [RENAME-CROSSLANGUAGE].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{Position, PrepareRenameResponse, Range, RenameParams, TextDocumentPositionParams};
use lspkit_server::CancellationToken;
use tracing::warn;

use crate::code_actions::{SidecarDocumentEdit, SidecarWorkspaceEdit};
use crate::paths::uri_to_path;
use crate::sidecar::manager::SidecarManager;
use crate::utils::SidecarPositionReq;

// Implements [RENAME-PREPARE]

/// Handle `textDocument/prepareRename` via the sidecar.
pub fn handle_prepare_rename(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };

    let params: TextDocumentPositionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(params.text_document.uri.as_str())?;
    let request = SidecarPositionReq {
        file_path,
        line: params.position.line,
        character: params.position.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        runtime.block_on(sidecar.request("textDocument/prepareRename", payload))?;
    let result: SidecarPrepareRenameResult = rmp_serde::from_slice(&response_bytes)?;

    if !result.can_rename {
        return Ok(serde_json::Value::Null);
    }

    let range = Range {
        start: Position {
            line: result.start_line,
            character: result.start_character,
        },
        end: Position {
            line: result.end_line,
            character: result.end_character,
        },
    };
    let response = PrepareRenameResponse::RangeWithPlaceholder {
        range,
        placeholder: result.placeholder,
    };
    Ok(serde_json::to_value(response)?)
}

// Implements [RENAME-APPLY] and [RENAME-CROSSLANGUAGE].

/// Handle `textDocument/rename` via the sidecar.
pub fn handle_rename(
    req: Request,
    runtime: &tokio::runtime::Handle,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: RenameParams = serde_json::from_value(req.params)?;
    let request = sidecar_rename_request(params)?;
    let result = request_workspace_edit(runtime, sidecar, "textDocument/rename", &request, cancel)?;
    let result = if result.document_changes.is_empty() {
        result
    } else {
        add_foreign_rename(runtime, sidecar, fallback, &request, result, cancel)
    };
    workspace_edit_value(result)
}

/// Convert LSP rename parameters into the sidecar's compact wire request.
fn sidecar_rename_request(params: RenameParams) -> Result<SidecarRenameRequest> {
    Ok(SidecarRenameRequest {
        file_path: uri_to_path(params.text_document_position.text_document.uri.as_str())?,
        line: params.text_document_position.position.line,
        character: params.text_document_position.position.character,
        new_name: params.new_name,
    })
}

/// Append edits produced by the sidecar that owns the other language.
///
/// Enrichment is **best-effort**: the primary sidecar has already produced a
/// correct rename, so a crashed, restarting or wedged fallback sidecar must never
/// discard it. Any fault is logged and the primary edits are returned unchanged.
fn add_foreign_rename(
    runtime: &tokio::runtime::Handle,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
    result: SidecarWorkspaceEditResult,
    cancel: &CancellationToken,
) -> SidecarWorkspaceEditResult {
    match foreign_rename_edits(runtime, primary, fallback, request, cancel) {
        Ok(Some(foreign)) => merge_or_keep(result, foreign),
        Ok(None) => result,
        Err(err) => {
            warn!("Cross-language rename enrichment failed, keeping primary edits: {err:#}");
            result
        }
    }
}

/// Merge foreign edits in, falling back to the primary edits if the merge conflicts.
fn merge_or_keep(
    result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> SidecarWorkspaceEditResult {
    // Preserve resource operations for the final refusal instead of hiding one
    // behind best-effort enrichment. [REFACTOR-NEVER-SILENT]
    if contains_resource_operation(&result) || contains_resource_operation(&foreign) {
        return concatenate_workspace_edits(result, foreign);
    }
    let primary = result.clone();
    match merge_workspace_edits(result, foreign) {
        Ok(merged) => merged,
        Err(err) => {
            warn!("Cross-language rename merge conflicted, keeping primary edits: {err:#}");
            primary
        }
    }
}

/// Ask the other-language sidecar for its edits, if it has a workspace that could hold any.
fn foreign_rename_edits(
    runtime: &tokio::runtime::Handle,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
    cancel: &CancellationToken,
) -> Result<Option<SidecarWorkspaceEditResult>> {
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    if !sidecar_workspace_loaded(runtime, fallback, Some(cancel))? {
        return Ok(None);
    }
    Ok(Some(request_foreign_rename(
        runtime, primary, fallback, request, cancel,
    )?))
}

/// Check whether the other-language sidecar has a project that can contain references.
pub(crate) fn sidecar_workspace_loaded(
    runtime: &tokio::runtime::Handle,
    sidecar: &Arc<SidecarManager>,
    cancel: Option<&CancellationToken>,
) -> Result<bool> {
    let bytes =
        runtime.block_on(sidecar.request_cancellable("workspace/status", Vec::new(), cancel))?;
    let status: String = rmp_serde::from_slice(&bytes)?;
    match status.as_str() {
        // Tier 2 remains a usable BCL workspace; only package symbols are absent.
        // Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
        "loaded" | "filebased-degraded" => Ok(true),
        "not_loaded" => Ok(false),
        other => anyhow::bail!("unexpected sidecar workspace status: {other}"),
    }
}

/// Resolve the primary symbol identity and ask the fallback for its references.
fn request_foreign_rename(
    runtime: &tokio::runtime::Handle,
    primary: &Arc<SidecarManager>,
    fallback: &Arc<SidecarManager>,
    request: &SidecarRenameRequest,
    cancel: &CancellationToken,
) -> Result<SidecarWorkspaceEditResult> {
    let identity = request_rename_identity(runtime, primary, request, cancel)?;
    if !identity.found || identity.assembly_name.is_empty() || identity.xml_doc_sig.is_empty() {
        return Ok(empty_workspace_edit());
    }
    let foreign = SidecarForeignRenameRequest::new(identity, request.new_name.clone());
    request_workspace_edit(
        runtime,
        fallback,
        "workspace/renameForeign",
        &foreign,
        cancel,
    )
}

/// Ask the owning sidecar for a portable assembly + XML-doc symbol identity.
fn request_rename_identity(
    runtime: &tokio::runtime::Handle,
    sidecar: &Arc<SidecarManager>,
    rename: &SidecarRenameRequest,
    cancel: &CancellationToken,
) -> Result<SidecarRenameIdentityResult> {
    let request = SidecarPositionReq {
        file_path: rename.file_path.clone(),
        line: rename.line,
        character: rename.character,
    };
    request_symbol_identity(runtime, sidecar, &request, Some(cancel))
}

/// Ask the sidecar that owns `at`'s document for the identity of the symbol
/// there: a C# source symbol, an F# one, or an F# project's symbol that C# or
/// Razor reads from its DLL. [DEFINITION-CROSSLANG-IDENTITY]
pub(crate) fn request_symbol_identity(
    runtime: &tokio::runtime::Handle,
    sidecar: &SidecarManager,
    at: &SidecarPositionReq,
    cancel: Option<&CancellationToken>,
) -> Result<SidecarRenameIdentityResult> {
    let payload = rmp_serde::to_vec(at)?;
    let bytes = runtime.block_on(sidecar.request_cancellable(
        "textDocument/renameIdentity",
        payload,
        cancel,
    ))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Send a sidecar request whose response uses the workspace-edit wire shape.
fn request_workspace_edit<T: serde::Serialize>(
    runtime: &tokio::runtime::Handle,
    sidecar: &Arc<SidecarManager>,
    method: &str,
    request: &T,
    cancel: &CancellationToken,
) -> Result<SidecarWorkspaceEditResult> {
    let payload = rmp_serde::to_vec(request)?;
    let bytes = runtime.block_on(sidecar.request_cancellable(method, payload, Some(cancel)))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Sidecar request to rename a symbol.
#[derive(serde::Serialize)]
struct SidecarRenameRequest {
    /// Absolute path to the file containing the symbol.
    file_path: String,
    /// Zero-based line of the symbol.
    line: u32,
    /// Zero-based character offset of the symbol.
    character: u32,
    /// New name for the symbol.
    new_name: String,
}

/// Portable metadata identity returned by the symbol's owning sidecar.
#[derive(serde::Deserialize)]
pub(crate) struct SidecarRenameIdentityResult {
    /// Whether the source position resolved to a cross-language-visible symbol.
    pub(crate) found: bool,
    /// Simple name of the assembly that owns the symbol.
    pub(crate) assembly_name: String,
    /// Standard .NET XML documentation signature for the symbol.
    pub(crate) xml_doc_sig: String,
}

/// Request for references to a metadata symbol owned by the other sidecar.
#[derive(serde::Serialize)]
struct SidecarForeignRenameRequest {
    /// Simple name of the symbol's owning assembly.
    assembly_name: String,
    /// Standard .NET XML documentation signature for the symbol.
    xml_doc_sig: String,
    /// Replacement identifier requested by the editor.
    new_name: String,
}

impl SidecarForeignRenameRequest {
    /// Build the fallback request from the primary sidecar's identity.
    fn new(identity: SidecarRenameIdentityResult, new_name: String) -> Self {
        Self {
            assembly_name: identity.assembly_name,
            xml_doc_sig: identity.xml_doc_sig,
            new_name,
        }
    }
}

/// Sidecar response indicating whether a symbol is renameable.
#[derive(serde::Deserialize)]
struct SidecarPrepareRenameResult {
    /// Whether the symbol at the position can be renamed.
    can_rename: bool,
    /// Start line of the symbol token.
    start_line: u32,
    /// Start character of the symbol token.
    start_character: u32,
    /// End line of the symbol token.
    end_line: u32,
    /// End character of the symbol token.
    end_character: u32,
    /// Current name of the symbol (used as the rename placeholder).
    placeholder: String,
}

/// A single text replacement from the sidecar.
#[derive(serde::Deserialize, Clone)]
struct SidecarTextEditResult {
    /// Start line of the range to replace.
    start_line: u32,
    /// Start character of the range to replace.
    start_character: u32,
    /// End line of the range to replace.
    end_line: u32,
    /// End character of the range to replace.
    end_character: u32,
    /// Replacement text.
    new_text: String,
}

/// Rename shares the code-action wire containers so positional fields cannot drift.
type SidecarDocumentEditResult = SidecarDocumentEdit<SidecarTextEditResult>;
/// The sidecar's rename result, decoded with the shared workspace-edit container.
type SidecarWorkspaceEditResult = SidecarWorkspaceEdit<SidecarTextEditResult>;

mod merge;
use merge::{
    concatenate_workspace_edits, contains_resource_operation, empty_workspace_edit,
    merge_workspace_edits, workspace_edit_value,
};

#[cfg(test)]
mod rename_tests;
