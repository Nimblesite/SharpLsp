//! Code action handlers (`textDocument/codeAction` and `codeAction/resolve`).
//!
//! Forwards requests to the .NET sidecar which uses Roslyn's
//! `CodeFixProvider` and `CodeRefactoringProvider` pipelines.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, CodeActionParams, CreateFile,
    CreateFileOptions, DocumentChangeOperation, DocumentChanges, OneOf,
    OptionalVersionedTextDocumentIdentifier, RenameFile, RenameFileOptions, ResourceOp,
    TextDocumentEdit, TextEdit, Uri, WorkspaceEdit,
};
use tracing::debug;

use crate::sidecar::manager::SidecarManager;
use crate::utils::{
    map_text_edit, request_sidecar, request_sidecar_strict, with_sidecar, SidecarTextEdit,
};

/// The plain-words reason a C# resolve answers with when no C# sidecar runs.
/// [REFACTOR-NEVER-SILENT]
const CSHARP_NOT_RUNNING: &str = "the C# language service is not running";

/// The plain-words reason an F# resolve answers with when no F# sidecar runs.
/// [REFACTOR-NEVER-SILENT]
const FSHARP_NOT_RUNNING: &str = "the F# language service is not running";

/// The reason an action with no resolvable id cannot resolve.
const MISSING_ID: &str = "the quick fix carries no id this server can resolve; invoke it again";

/// Handle `textDocument/codeAction` — returns available code fixes and refactorings.
pub fn handle_code_action(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: CodeActionParams| {
        let request = SidecarCodeActionReq {
            file_path: crate::paths::uri_to_path(params.text_document.uri.as_str())?,
            start_line: params.range.start.line,
            start_character: params.range.start.character,
            end_line: params.range.end.line,
            end_character: params.range.end.character,
        };
        let Some(items) = request_sidecar::<Vec<SidecarCodeActionItem>, _>(
            runtime,
            sidecar,
            "textDocument/codeAction",
            &request,
        )?
        else {
            return Ok(serde_json::Value::Null);
        };
        debug!("Got {} code actions from sidecar", items.len());
        let doc_uri = params.text_document.uri;
        let actions: Vec<CodeActionOrCommand> = items
            .iter()
            .map(|item| CodeActionOrCommand::CodeAction(map_code_action(item, &doc_uri)))
            .collect();
        Ok(serde_json::to_value(actions)?)
    })
}

/// Handle `codeAction/resolve` — resolves a code action to a full workspace edit.
/// A resolve that cannot produce the edit is an LSP error response carrying the
/// reason — never a `null` result the editor would read as "no change".
/// [REFACTOR-NEVER-SILENT]
pub fn handle_code_action_resolve(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let request_id = req.id;
    let action: CodeAction = serde_json::from_value(req.params)?;
    let Some(sidecar) = sidecar else {
        return Err(refused(&request_id, None, service_not_running(&action)));
    };
    let id =
        resolve_id(&action).ok_or_else(|| refused(&request_id, None, MISSING_ID.to_string()))?;
    let edit = request_sidecar_strict::<SidecarWorkspaceEdit, _>(
        runtime,
        sidecar,
        "codeAction/resolve",
        &SidecarCodeActionResolveReq { id },
    )
    .map_err(|error| refused(&request_id, Some(id), error.to_string()))?;
    let mut resolved = action;
    resolved.edit = Some(
        map_workspace_edit(&edit)
            .map_err(|error| refused(&request_id, Some(id), error.to_string()))?,
    );
    Ok(serde_json::to_value(resolved)?)
}

/// The id a resolve carries in its `data`, when it has one.
fn resolve_id(action: &CodeAction) -> Option<i32> {
    action
        .data
        .as_ref()
        .and_then(|data| data.get("id"))
        .and_then(|id| serde_json::from_value(id.clone()).ok())
}

/// The plain-words reason a resolve answers when no sidecar runs for the
/// document's language. [REFACTOR-NEVER-SILENT]
fn service_not_running(action: &CodeAction) -> String {
    let language = action
        .data
        .as_ref()
        .and_then(|data| data.get("uri"))
        .and_then(|uri| uri.as_str())
        .and_then(|raw| raw.parse::<Uri>().ok())
        .and_then(|uri| crate::tree_sitter_parse::LangId::from_uri(&uri));
    match language {
        Some(crate::tree_sitter_parse::LangId::FSharp) => FSHARP_NOT_RUNNING,
        _ => CSHARP_NOT_RUNNING,
    }
    .to_string()
}

/// Record the refusal at `warn` with structured fields, as the spec requires,
/// and return it as the handler's error so it reaches the client.
/// [REFACTOR-NEVER-SILENT]
fn refused(
    request_id: &lsp_server::RequestId,
    action: Option<i32>,
    reason: String,
) -> anyhow::Error {
    tracing::warn!(
        method = "codeAction/resolve",
        id = ?request_id,
        action = ?action,
        reason = %reason,
        "code action resolve refused"
    );
    anyhow::anyhow!(reason)
}

/// Convert a sidecar code action item into an LSP `CodeAction`: an edit the
/// client resolves by `data` and, when it also needs a reference, the command
/// the client runs after applying that edit. [REFACTOR-IMPORT-REFERENCE]
fn map_code_action(item: &SidecarCodeActionItem, doc_uri: &Uri) -> CodeAction {
    let data = serde_json::json!({"id": item.id, "uri": doc_uri.as_str()});
    CodeAction {
        title: item.title.clone(),
        kind: Some(map_action_kind(&item.kind)),
        is_preferred: Some(item.is_preferred),
        command: item
            .reference
            .as_ref()
            .map(|reference| crate::import_command::command(&item.title, &data, reference)),
        data: Some(data),
        ..CodeAction::default()
    }
}

/// Map a sidecar action kind string to the LSP `CodeActionKind`.
fn map_action_kind(kind: &str) -> CodeActionKind {
    match kind {
        "refactor.extract" => CodeActionKind::REFACTOR_EXTRACT,
        "refactor.inline" => CodeActionKind::REFACTOR_INLINE,
        "refactor.rewrite" => CodeActionKind::REFACTOR_REWRITE,
        "source.organizeImports" => CodeActionKind::SOURCE_ORGANIZE_IMPORTS,
        "refactor" => CodeActionKind::REFACTOR,
        _ => CodeActionKind::QUICKFIX,
    }
}

/// Convert a sidecar workspace edit into an LSP `WorkspaceEdit`.
/// The LSP edit for a sidecar edit: a map of text edits by file, or document
/// changes when it creates or renames a file. Resource operations precede the
/// text edits that depend on them. [RAZOR-CODE-ACTIONS]
/// [REFACTOR-MOVE-TYPE-RENAME-FILE]
fn map_workspace_edit(edit: &SidecarWorkspaceEdit) -> anyhow::Result<WorkspaceEdit> {
    if edit
        .document_changes
        .iter()
        .any(|change| change.create || change.rename_to.is_some())
    {
        let operations: Vec<DocumentChangeOperation> = edit
            .document_changes
            .iter()
            .map(document_operations)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok(WorkspaceEdit {
            document_changes: Some(DocumentChanges::Operations(operations)),
            ..WorkspaceEdit::default()
        })
    } else {
        map_text_changes(edit)
    }
}

/// A document's resource operations, then edits against the resulting URI.
/// A path that cannot become a URI fails the resolve instead of dropping the
/// edit. [REFACTOR-NEVER-SILENT]
fn document_operations(
    change: &SidecarDocumentEdit,
) -> anyhow::Result<Vec<DocumentChangeOperation>> {
    let old_uri = uri_of(&change.file_path)?;
    let target_path = change.rename_to.as_deref().unwrap_or(&change.file_path);
    let target_uri = uri_of(target_path)?;
    let create = change.create.then(|| create_operation(old_uri.clone()));
    let rename = change
        .rename_to
        .as_ref()
        .map(|_| rename_operation(old_uri, target_uri.clone()));
    let edits = (!change.edits.is_empty() || change.rename_to.is_none())
        .then(|| text_operation(target_uri, change));
    Ok(create.into_iter().chain(rename).chain(edits).collect())
}

/// The URI of an edit's path, or the reason it cannot become one — a path that
/// fails to convert must fail the resolve, never vanish. [REFACTOR-NEVER-SILENT]
fn uri_of(path: &str) -> anyhow::Result<Uri> {
    crate::paths::path_to_lsp_uri(path).map_err(|error| {
        anyhow::anyhow!("the edit names the path '{path}', which cannot become a URI: {error}")
    })
}

/// Create a file without replacing an existing one. [RAZOR-CODE-ACTIONS]
fn create_operation(uri: Uri) -> DocumentChangeOperation {
    DocumentChangeOperation::Op(ResourceOp::Create(CreateFile {
        uri,
        options: Some(CreateFileOptions {
            overwrite: Some(false),
            ignore_if_exists: Some(false),
        }),
        annotation_id: None,
    }))
}

/// Rename a file without replacing an existing target. [REFACTOR-MOVE-TYPE-RENAME-FILE]
fn rename_operation(old_uri: Uri, new_uri: Uri) -> DocumentChangeOperation {
    DocumentChangeOperation::Op(ResourceOp::Rename(RenameFile {
        old_uri,
        new_uri,
        options: Some(RenameFileOptions {
            overwrite: Some(false),
            ignore_if_exists: Some(false),
        }),
        annotation_id: None,
    }))
}

/// Edit the document at its URI after any resource operation.
fn text_operation(uri: Uri, change: &SidecarDocumentEdit) -> DocumentChangeOperation {
    DocumentChangeOperation::Edit(TextDocumentEdit {
        text_document: OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits: change
            .edits
            .iter()
            .map(map_text_edit)
            .map(OneOf::Left)
            .collect(),
    })
}

/// A sidecar edit that creates no file, as per-document text changes.
#[expect(
    clippy::mutable_key_type,
    reason = "Uri is the key type mandated by lsp-types WorkspaceEdit"
)]
fn map_text_changes(edit: &SidecarWorkspaceEdit) -> anyhow::Result<WorkspaceEdit> {
    let mut changes = std::collections::HashMap::new();
    for doc_edit in &edit.document_changes {
        let uri = uri_of(&doc_edit.file_path)?;
        let edits: Vec<TextEdit> = doc_edit.edits.iter().map(map_text_edit).collect();
        let _ = changes.insert(uri, edits);
    }
    Ok(WorkspaceEdit {
        changes: Some(changes),
        ..WorkspaceEdit::default()
    })
}

// ── Sidecar wire types (MessagePack) ──────────────────────────────

/// Request sent to the sidecar for code actions at a given range.
#[derive(serde::Serialize)]
struct SidecarCodeActionReq {
    /// Absolute path to the source file.
    file_path: String,
    /// Start line of the selection range.
    start_line: u32,
    /// Start character offset within the start line.
    start_character: u32,
    /// End line of the selection range.
    end_line: u32,
    /// End character offset within the end line.
    end_character: u32,
}

/// A single code action returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarCodeActionItem {
    /// Unique identifier for resolving this action later.
    id: i32,
    /// Human-readable title shown in the editor.
    title: String,
    /// Action kind string (e.g. "quickfix", "refactor.extract").
    kind: String,
    /// Whether this action is the preferred fix for the diagnostic.
    is_preferred: bool,
    /// The reference a command action adds before its import; `None` for an
    /// edit action. [REFACTOR-IMPORT-REFERENCE]
    #[serde(default)]
    reference: Option<crate::import_command::SidecarReferenceImport>,
}

/// Request sent to the sidecar to resolve a code action by ID.
#[derive(serde::Serialize)]
struct SidecarCodeActionResolveReq {
    /// Identifier of the code action to resolve.
    id: i32,
}

/// Edits for a single document returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarDocumentEdit {
    /// Absolute path of the file being edited.
    file_path: String,
    /// Text edits to apply to this document.
    edits: Vec<SidecarTextEdit>,
    /// Whether the edit creates the file, whose whole text it then holds.
    #[serde(default)]
    create: bool,
    /// The new absolute path when this edit renames the file.
    /// [REFACTOR-MOVE-TYPE-RENAME-FILE]
    #[serde(default)]
    rename_to: Option<String>,
}

/// A workspace-wide set of edits returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarWorkspaceEdit {
    /// Per-document edits that compose this workspace edit.
    document_changes: Vec<SidecarDocumentEdit>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests;
