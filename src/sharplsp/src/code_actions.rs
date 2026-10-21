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
    OptionalVersionedTextDocumentIdentifier, ResourceOp, TextDocumentEdit, TextEdit, Uri,
    WorkspaceEdit,
};
use tracing::debug;

use crate::sidecar::manager::SidecarManager;
use crate::utils::{map_text_edit, request_sidecar, with_sidecar, SidecarTextEdit};

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
pub fn handle_code_action_resolve(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, action: CodeAction| {
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
        let Some(edit) = request_sidecar::<SidecarWorkspaceEdit, _>(
            runtime,
            sidecar,
            "codeAction/resolve",
            &resolve_req,
        )?
        else {
            return Ok(serde_json::Value::Null);
        };
        let mut resolved = action;
        resolved.edit = Some(map_workspace_edit(&edit));
        Ok(serde_json::to_value(resolved)?)
    })
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
/// The LSP edit for a sidecar edit: a map of text edits by file, or, when it
/// creates a file, document changes that create each new file before editing
/// it, since a text edit cannot reach a file that does not exist yet.
/// [RAZOR-CODE-ACTIONS]
fn map_workspace_edit(edit: &SidecarWorkspaceEdit) -> WorkspaceEdit {
    if edit.document_changes.iter().any(|change| change.create) {
        WorkspaceEdit {
            document_changes: Some(DocumentChanges::Operations(
                edit.document_changes
                    .iter()
                    .flat_map(document_operations)
                    .collect(),
            )),
            ..WorkspaceEdit::default()
        }
    } else {
        map_text_changes(edit)
    }
}

/// A document's operations: its creation when it is new, then its edits.
fn document_operations(change: &SidecarDocumentEdit) -> Vec<DocumentChangeOperation> {
    let Ok(uri) = crate::paths::path_to_lsp_uri(&change.file_path) else {
        return Vec::new();
    };
    let create = change.create.then(|| {
        DocumentChangeOperation::Op(ResourceOp::Create(CreateFile {
            uri: uri.clone(),
            options: Some(CreateFileOptions {
                overwrite: Some(false),
                ignore_if_exists: Some(false),
            }),
            annotation_id: None,
        }))
    });
    let edits = DocumentChangeOperation::Edit(TextDocumentEdit {
        text_document: OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits: change
            .edits
            .iter()
            .map(map_text_edit)
            .map(OneOf::Left)
            .collect(),
    });
    create.into_iter().chain([edits]).collect()
}

/// A sidecar edit that creates no file, as per-document text changes.
#[expect(
    clippy::mutable_key_type,
    reason = "Uri is the key type mandated by lsp-types WorkspaceEdit"
)]
fn map_text_changes(edit: &SidecarWorkspaceEdit) -> WorkspaceEdit {
    let mut changes = std::collections::HashMap::new();
    for doc_edit in &edit.document_changes {
        if let Ok(uri) = crate::paths::path_to_lsp_uri(&doc_edit.file_path) {
            let edits: Vec<TextEdit> = doc_edit.edits.iter().map(map_text_edit).collect();
            let _ = changes.insert(uri, edits);
        }
    }
    WorkspaceEdit {
        changes: Some(changes),
        ..WorkspaceEdit::default()
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
    clippy::indexing_slicing,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn map_action_kind_known_kinds() {
        assert_eq!(
            map_action_kind("refactor.extract"),
            CodeActionKind::REFACTOR_EXTRACT
        );
        assert_eq!(
            map_action_kind("refactor.inline"),
            CodeActionKind::REFACTOR_INLINE
        );
        assert_eq!(
            map_action_kind("refactor.rewrite"),
            CodeActionKind::REFACTOR_REWRITE
        );
        assert_eq!(
            map_action_kind("source.organizeImports"),
            CodeActionKind::SOURCE_ORGANIZE_IMPORTS,
        );
        assert_eq!(map_action_kind("refactor"), CodeActionKind::REFACTOR);
    }

    #[test]
    fn map_action_kind_unknown_falls_back_to_quickfix() {
        assert_eq!(map_action_kind(""), CodeActionKind::QUICKFIX);
        assert_eq!(map_action_kind("anything-else"), CodeActionKind::QUICKFIX);
    }

    #[test]
    fn map_code_action_carries_metadata() {
        let item = SidecarCodeActionItem {
            id: 7,
            title: "Add using".to_string(),
            kind: "quickfix".to_string(),
            is_preferred: true,
        };
        let uri: Uri = "file:///tmp/Foo.cs".parse().unwrap();
        let action = map_code_action(&item, &uri);
        assert_eq!(action.title, "Add using");
        assert_eq!(action.kind, Some(CodeActionKind::QUICKFIX));
        assert_eq!(action.is_preferred, Some(true));
        let data = action.data.unwrap();
        assert_eq!(data["id"], serde_json::json!(7));
        assert_eq!(data["uri"], serde_json::json!("file:///tmp/Foo.cs"));
    }

    #[test]
    #[expect(
        clippy::mutable_key_type,
        reason = "Uri is the key type mandated by lsp-types WorkspaceEdit"
    )]
    fn map_workspace_edit_groups_edits_by_uri() {
        use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
        let edit = SidecarWorkspaceEdit {
            document_changes: vec![SidecarDocumentEdit {
                create: false,
                file_path: NATIVE_FILE.to_string(),
                edits: vec![
                    SidecarTextEdit {
                        start_line: 0,
                        start_character: 0,
                        end_line: 0,
                        end_character: 1,
                        new_text: "a".to_string(),
                    },
                    SidecarTextEdit {
                        start_line: 5,
                        start_character: 6,
                        end_line: 5,
                        end_character: 7,
                        new_text: "b".to_string(),
                    },
                ],
            }],
        };
        let workspace_edit = map_workspace_edit(&edit);
        let changes = workspace_edit.changes.unwrap();
        assert_eq!(changes.len(), 1);
        let (uri, edits) = changes.iter().next().unwrap();
        assert_eq!(uri.as_str(), NATIVE_FILE_URI);
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0].new_text, "a");
        assert_eq!(edits[1].new_text, "b");
    }

    #[test]
    fn map_workspace_edit_skips_unparseable_paths() {
        let edit = SidecarWorkspaceEdit {
            document_changes: vec![SidecarDocumentEdit {
                create: false,
                file_path: "\u{0}".to_string(),
                edits: vec![],
            }],
        };
        let workspace_edit = map_workspace_edit(&edit);
        assert!(workspace_edit.changes.unwrap().is_empty());
    }

    /// An edit that creates a file creates it before writing its text, and
    /// edits the other files in the same document changes. [RAZOR-CODE-ACTIONS]
    #[test]
    fn map_workspace_edit_creates_new_files_before_editing_them() {
        use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
        let text = |new_text: &str| SidecarTextEdit {
            start_line: 0,
            start_character: 0,
            end_line: 0,
            end_character: 0,
            new_text: new_text.to_string(),
        };
        let created = format!("{NATIVE_FILE}.cs");
        let edit = SidecarWorkspaceEdit {
            document_changes: vec![
                SidecarDocumentEdit {
                    create: true,
                    file_path: created.clone(),
                    edits: vec![text("public partial class Counter {}")],
                },
                SidecarDocumentEdit {
                    create: false,
                    file_path: NATIVE_FILE.to_string(),
                    edits: vec![text("")],
                },
            ],
        };
        let workspace_edit = map_workspace_edit(&edit);
        assert!(workspace_edit.changes.is_none());
        let operations = match workspace_edit.document_changes {
            Some(DocumentChanges::Operations(operations)) => operations,
            _ => Vec::new(),
        };
        let steps: Vec<(&str, &str, Option<bool>, usize)> =
            operations.iter().map(operation_step).collect();
        let created_uri = crate::paths::path_to_lsp_uri(&created).unwrap();
        assert_eq!(
            steps,
            [
                ("create", created_uri.as_str(), Some(false), 0),
                ("edit", created_uri.as_str(), None, 1),
                ("edit", NATIVE_FILE_URI, None, 1),
            ],
            "the new file is created, then written, then the existing file is edited"
        );
        assert!(
            operations.iter().all(|operation| !matches!(
                operation,
                DocumentChangeOperation::Edit(TextDocumentEdit {
                    text_document: OptionalVersionedTextDocumentIdentifier {
                        version: Some(_),
                        ..
                    },
                    ..
                })
            )),
            "no edit pins a document version"
        );
    }

    /// A creating edit drops a document whose path is no URI, and keeps the
    /// others: the new file is still created. [RAZOR-CODE-ACTIONS]
    #[test]
    fn map_workspace_edit_creating_files_skips_unparseable_paths() {
        use crate::paths::test_paths::NATIVE_FILE;
        let created = format!("{NATIVE_FILE}.cs");
        let edit = SidecarWorkspaceEdit {
            document_changes: vec![
                SidecarDocumentEdit {
                    create: true,
                    file_path: created.clone(),
                    edits: vec![],
                },
                SidecarDocumentEdit {
                    create: false,
                    file_path: "\u{0}".to_string(),
                    edits: vec![],
                },
            ],
        };
        let operations = match map_workspace_edit(&edit).document_changes {
            Some(DocumentChanges::Operations(operations)) => operations,
            _ => Vec::new(),
        };
        let created_uri = crate::paths::path_to_lsp_uri(&created).unwrap();
        let steps: Vec<_> = operations.iter().map(operation_step).collect();
        assert_eq!(
            steps,
            [
                ("create", created_uri.as_str(), Some(false), 0),
                ("edit", created_uri.as_str(), None, 0),
            ]
        );
    }

    /// An operation as `(kind, uri, overwrite, edit count)`.
    fn operation_step(operation: &DocumentChangeOperation) -> (&str, &str, Option<bool>, usize) {
        match operation {
            DocumentChangeOperation::Op(ResourceOp::Create(create)) => (
                "create",
                create.uri.as_str(),
                create
                    .options
                    .as_ref()
                    .and_then(|options| options.overwrite),
                0,
            ),
            DocumentChangeOperation::Edit(edit) => (
                "edit",
                edit.text_document.uri.as_str(),
                None,
                edit.edits.len(),
            ),
            DocumentChangeOperation::Op(_) => ("other", "", None, 0),
        }
    }
}
