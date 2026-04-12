//! Code action handlers (`textDocument/codeAction` and `codeAction/resolve`).
//!
//! Forwards requests to the .NET sidecar which uses Roslyn's
//! `CodeFixProvider` and `CodeRefactoringProvider` pipelines.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CodeAction, CodeActionKind, CodeActionOrCommand, CodeActionParams, Position, Range, TextEdit,
    Uri, WorkspaceEdit,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/codeAction` — returns available code fixes and refactorings.
pub fn handle_code_action(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CodeActionParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarCodeActionReq {
        file_path,
        start_line: params.range.start.line,
        start_character: params.range.start.character,
        end_line: params.range.end.line,
        end_character: params.range.end.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/codeAction", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar codeAction unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let items: Vec<SidecarCodeActionItem> = rmp_serde::from_slice(&response_bytes)?;
    debug!("Got {} code actions from sidecar", items.len());

    let doc_uri = params.text_document.uri;
    let actions: Vec<CodeActionOrCommand> = items
        .into_iter()
        .map(|item| CodeActionOrCommand::CodeAction(map_code_action(&item, &doc_uri)))
        .collect();

    Ok(serde_json::to_value(actions)?)
}

/// Handle `codeAction/resolve` — resolves a code action to a full workspace edit.
pub fn handle_code_action_resolve(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let action: CodeAction = serde_json::from_value(req.params)?;
    let data = action
        .data
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("codeAction/resolve: missing data field"))?;

    // Data format: {"id": N, "uri": "file://..."} — extract just the ID for the sidecar.
    let action_id: i32 = data
        .get("id")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| anyhow::anyhow!("codeAction/resolve: missing id in data"))?;
    let resolve_req = SidecarCodeActionResolveReq { id: action_id };
    let payload = rmp_serde::to_vec(&resolve_req)?;
    let response_bytes = match runtime.block_on(sidecar.request("codeAction/resolve", payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar codeAction/resolve unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let edit: SidecarWorkspaceEdit = rmp_serde::from_slice(&response_bytes)?;
    let mut resolved = action;
    resolved.edit = Some(map_workspace_edit(&edit));
    Ok(serde_json::to_value(resolved)?)
}

/// Convert a sidecar code action item into an LSP `CodeAction`.
fn map_code_action(item: &SidecarCodeActionItem, doc_uri: &Uri) -> CodeAction {
    CodeAction {
        title: item.title.clone(),
        kind: Some(map_action_kind(&item.kind)),
        is_preferred: Some(item.is_preferred),
        data: Some(serde_json::json!({"id": item.id, "uri": doc_uri.as_str()})),
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
#[expect(
    clippy::mutable_key_type,
    reason = "Uri is the key type mandated by lsp-types WorkspaceEdit"
)]
fn map_workspace_edit(edit: &SidecarWorkspaceEdit) -> WorkspaceEdit {
    let mut changes = std::collections::HashMap::new();
    for doc_edit in &edit.document_changes {
        let path = format!("file://{}", doc_edit.file_path);
        if let Ok(uri) = path.parse::<Uri>() {
            let edits: Vec<TextEdit> = doc_edit.edits.iter().map(map_text_edit).collect();
            let _ = changes.insert(uri, edits);
        }
    }
    WorkspaceEdit {
        changes: Some(changes),
        ..WorkspaceEdit::default()
    }
}

/// Convert a sidecar text edit into an LSP `TextEdit`.
fn map_text_edit(edit: &SidecarTextEdit) -> TextEdit {
    TextEdit {
        range: Range::new(
            Position::new(edit.start_line, edit.start_character),
            Position::new(edit.end_line, edit.end_character),
        ),
        new_text: edit.new_text.clone(),
    }
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
}

/// Request sent to the sidecar to resolve a code action by ID.
#[derive(serde::Serialize)]
struct SidecarCodeActionResolveReq {
    /// Identifier of the code action to resolve.
    id: i32,
}

/// A single text edit returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarTextEdit {
    /// Start line of the range to replace.
    start_line: u32,
    /// Start character offset within the start line.
    start_character: u32,
    /// End line of the range to replace.
    end_line: u32,
    /// End character offset within the end line.
    end_character: u32,
    /// Replacement text to insert at the range.
    new_text: String,
}

/// Edits for a single document returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarDocumentEdit {
    /// Absolute path of the file being edited.
    file_path: String,
    /// Text edits to apply to this document.
    edits: Vec<SidecarTextEdit>,
}

/// A workspace-wide set of edits returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarWorkspaceEdit {
    /// Per-document edits that compose this workspace edit.
    document_changes: Vec<SidecarDocumentEdit>,
}
