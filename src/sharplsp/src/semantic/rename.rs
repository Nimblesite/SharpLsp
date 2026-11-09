//! Rename through the sidecars: prepare, apply and the cross-language merge.
//! Implements [RENAME-PREPARE], [RENAME-APPLY], [RENAME-CROSSLANGUAGE].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    OneOf, Position, PrepareRenameResponse, Range, RenameParams, TextDocumentPositionParams,
    TextEdit, WorkspaceEdit,
};
use tracing::warn;

use crate::code_actions::{SidecarDocumentEdit, SidecarWorkspaceEdit};
use crate::paths::{normalized_rename_path, path_to_lsp_uri, uri_to_path};
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
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: RenameParams = serde_json::from_value(req.params)?;
    let request = sidecar_rename_request(params)?;
    let result = request_workspace_edit(runtime, sidecar, "textDocument/rename", &request)?;
    let result = if result.document_changes.is_empty() {
        result
    } else {
        add_foreign_rename(runtime, sidecar, fallback, &request, result)
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
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
    result: SidecarWorkspaceEditResult,
) -> SidecarWorkspaceEditResult {
    match foreign_rename_edits(runtime, primary, fallback, request) {
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
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
) -> Result<Option<SidecarWorkspaceEditResult>> {
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    if !sidecar_workspace_loaded(runtime, fallback)? {
        return Ok(None);
    }
    Ok(Some(request_foreign_rename(
        runtime, primary, fallback, request,
    )?))
}

/// Check whether the other-language sidecar has a project that can contain references.
pub(crate) fn sidecar_workspace_loaded(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
) -> Result<bool> {
    let bytes = runtime.block_on(sidecar.request("workspace/status", Vec::new()))?;
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
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: &Arc<SidecarManager>,
    request: &SidecarRenameRequest,
) -> Result<SidecarWorkspaceEditResult> {
    let identity = request_rename_identity(runtime, primary, request)?;
    if !identity.found || identity.assembly_name.is_empty() || identity.xml_doc_sig.is_empty() {
        return Ok(empty_workspace_edit());
    }
    let foreign = SidecarForeignRenameRequest::new(identity, request.new_name.clone());
    request_workspace_edit(runtime, fallback, "workspace/renameForeign", &foreign)
}

/// Ask the owning sidecar for a portable assembly + XML-doc symbol identity.
fn request_rename_identity(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    rename: &SidecarRenameRequest,
) -> Result<SidecarRenameIdentityResult> {
    let request = SidecarPositionReq {
        file_path: rename.file_path.clone(),
        line: rename.line,
        character: rename.character,
    };
    request_symbol_identity(runtime, sidecar, &request)
}

/// Ask the sidecar that owns `at`'s document for the identity of the symbol
/// there: a C# source symbol, an F# one, or an F# project's symbol that C# or
/// Razor reads from its DLL. [DEFINITION-CROSSLANG-IDENTITY]
pub(crate) fn request_symbol_identity(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    at: &SidecarPositionReq,
) -> Result<SidecarRenameIdentityResult> {
    let payload = rmp_serde::to_vec(at)?;
    let bytes = runtime.block_on(sidecar.request("textDocument/renameIdentity", payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Send a sidecar request whose response uses the workspace-edit wire shape.
fn request_workspace_edit<T: serde::Serialize>(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    method: &str,
    request: &T,
) -> Result<SidecarWorkspaceEditResult> {
    let payload = rmp_serde::to_vec(request)?;
    let bytes = runtime.block_on(sidecar.request(method, payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Construct an empty sidecar workspace edit.
fn empty_workspace_edit() -> SidecarWorkspaceEditResult {
    SidecarWorkspaceEditResult {
        document_changes: Vec::new(),
    }
}

/// Convert the merged sidecar result into an LSP workspace edit or `null`.
fn workspace_edit_value(result: SidecarWorkspaceEditResult) -> Result<serde_json::Value> {
    let result = canonicalize_workspace_edit(result)?;
    // One unconvertible document path must not sink an otherwise valid rename —
    // skip it and keep every edit we can represent.
    let edits: Vec<_> = result
        .document_changes
        .into_iter()
        .filter_map(|change| match lsp_document_edit(change) {
            Ok(edit) => Some(edit),
            Err(err) => {
                warn!("Skipping rename edit for an unconvertible document path: {err:#}");
                None
            }
        })
        .collect();
    if edits.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let workspace_edit = WorkspaceEdit {
        document_changes: Some(lsp_types::DocumentChanges::Edits(edits)),
        ..WorkspaceEdit::default()
    };
    Ok(serde_json::to_value(workspace_edit)?)
}

/// Convert one sidecar document edit into its LSP representation.
fn lsp_document_edit(edit: SidecarDocumentEditResult) -> Result<lsp_types::TextDocumentEdit> {
    let uri = path_to_lsp_uri(&edit.file_path)?;
    let edits = edit.edits.into_iter().map(lsp_rename_edit).collect();
    Ok(lsp_types::TextDocumentEdit {
        text_document: lsp_types::OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits,
    })
}

/// Convert one sidecar rename replacement into an unannotated LSP text edit.
fn lsp_rename_edit(edit: SidecarTextEditResult) -> OneOf<TextEdit, lsp_types::AnnotatedTextEdit> {
    OneOf::Left(TextEdit {
        range: Range {
            start: Position {
                line: edit.start_line,
                character: edit.start_character,
            },
            end: Position {
                line: edit.end_line,
                character: edit.end_character,
            },
        },
        new_text: edit.new_text,
    })
}

/// Merge fallback documents into the primary result and stabilize their order.
fn merge_workspace_edits(
    result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> Result<SidecarWorkspaceEditResult> {
    canonicalize_workspace_edit(concatenate_workspace_edits(result, foreign))
}

/// Keep both sides verbatim so validation sees every resource operation.
fn concatenate_workspace_edits(
    result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> SidecarWorkspaceEditResult {
    let document_changes = result
        .document_changes
        .into_iter()
        .chain(foreign.document_changes)
        .collect();
    SidecarWorkspaceEditResult { document_changes }
}

/// Merge duplicate document entries, normalize edit order, and reject conflicts.
fn canonicalize_workspace_edit(
    result: SidecarWorkspaceEditResult,
) -> Result<SidecarWorkspaceEditResult> {
    ensure_rename_text_only(&result)?;
    let mut canonical = empty_workspace_edit();
    for edit in result.document_changes {
        merge_document_edit(&mut canonical, edit);
    }
    canonical
        .document_changes
        .sort_by_key(|edit| normalized_rename_path(&edit.file_path));
    validate_workspace_edits(&canonical)?;
    Ok(canonical)
}

/// Whether any document asks rename to perform a file resource operation.
fn contains_resource_operation(result: &SidecarWorkspaceEditResult) -> bool {
    result
        .document_changes
        .iter()
        .any(|document| document.create || document.rename_to.is_some())
}

/// Rename returns text edits only; resource operations fail with a reason.
/// [REFACTOR-NEVER-SILENT]
fn ensure_rename_text_only(result: &SidecarWorkspaceEditResult) -> Result<()> {
    if contains_resource_operation(result) {
        anyhow::bail!("rename cannot create or rename files");
    }
    Ok(())
}

/// Reject invalid, overlapping, or conflicting edits in every document.
fn validate_workspace_edits(result: &SidecarWorkspaceEditResult) -> Result<()> {
    for document in &result.document_changes {
        validate_rename_edits(&document.file_path, &document.edits)?;
    }
    Ok(())
}

/// Reject invalid or overlapping replacement ranges within one document.
fn validate_rename_edits(path: &str, edits: &[SidecarTextEditResult]) -> Result<()> {
    for edit in edits {
        if rename_edit_start(edit) > rename_edit_end(edit) {
            anyhow::bail!("invalid rename range returned for {path}");
        }
    }
    let overlaps = edits.windows(2).any(|pair| match pair {
        [left, right] => rename_edits_overlap(left, right),
        _ => false,
    });
    if overlaps {
        anyhow::bail!("overlapping rename edits returned for {path}");
    }
    Ok(())
}

/// Test whether two half-open edit ranges conflict, including point insertions.
fn rename_edits_overlap(left: &SidecarTextEditResult, right: &SidecarTextEditResult) -> bool {
    let (left_start, left_end) = (rename_edit_start(left), rename_edit_end(left));
    let (right_start, right_end) = (rename_edit_start(right), rename_edit_end(right));
    if left_start == left_end {
        return (right_start == right_end && left_start == right_start)
            || (right_start <= left_start && left_start < right_end);
    }
    if right_start == right_end {
        return left_start <= right_start && right_start < left_end;
    }
    left_start < right_end && right_start < left_end
}

/// Return an edit's zero-based inclusive start position.
fn rename_edit_start(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.start_line, edit.start_character)
}

/// Return an edit's zero-based exclusive end position.
fn rename_edit_end(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.end_line, edit.end_character)
}

/// Merge one normalized document into the accumulated result.
fn merge_document_edit(
    result: &mut SidecarWorkspaceEditResult,
    mut incoming: SidecarDocumentEditResult,
) {
    let key = normalized_rename_path(&incoming.file_path);
    let existing = result
        .document_changes
        .iter_mut()
        .find(|edit| normalized_rename_path(&edit.file_path) == key);
    if let Some(existing) = existing {
        existing.edits.append(&mut incoming.edits);
        normalize_rename_edits(&mut existing.edits);
    } else {
        normalize_rename_edits(&mut incoming.edits);
        result.document_changes.push(incoming);
    }
}

/// Sort and remove duplicate range/replacement tuples.
fn normalize_rename_edits(edits: &mut Vec<SidecarTextEditResult>) {
    edits.sort_by(compare_rename_edits);
    edits.dedup_by(|right, left| same_rename_edit(left, right));
}

/// Compare rename edits in deterministic source order.
fn compare_rename_edits(
    left: &SidecarTextEditResult,
    right: &SidecarTextEditResult,
) -> std::cmp::Ordering {
    rename_edit_key(left).cmp(&rename_edit_key(right))
}

/// Return the fields that uniquely identify a rename replacement.
fn rename_edit_key(edit: &SidecarTextEditResult) -> (u32, u32, u32, u32, &str) {
    (
        edit.start_line,
        edit.start_character,
        edit.end_line,
        edit.end_character,
        edit.new_text.as_str(),
    )
}

/// Test whether two replacements target the same range with the same text.
fn same_rename_edit(left: &SidecarTextEditResult, right: &SidecarTextEditResult) -> bool {
    rename_edit_key(left) == rename_edit_key(right)
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

#[cfg(test)]
mod rename_tests;
