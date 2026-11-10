//! Merging and validating the sidecars' rename edits into one LSP
//! `WorkspaceEdit`: the owning sidecar's edits first, the other language's
//! appended, duplicates and overlaps rejected. [RENAME-APPLY] [RENAME-CROSSLANGUAGE]

use anyhow::Result;
use lsp_types::{OneOf, Position, Range, TextEdit, WorkspaceEdit};
use tracing::warn;

use super::{SidecarDocumentEditResult, SidecarTextEditResult, SidecarWorkspaceEditResult};
use crate::paths::{normalized_rename_path, path_to_lsp_uri};

/// Merge fallback documents into the primary result and stabilize their order.
pub(super) fn merge_workspace_edits(
    result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> Result<SidecarWorkspaceEditResult> {
    canonicalize_workspace_edit(concatenate_workspace_edits(result, foreign))
}

/// Keep both sides verbatim so validation sees every resource operation.
pub(super) fn concatenate_workspace_edits(
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
pub(super) fn canonicalize_workspace_edit(
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
pub(super) fn contains_resource_operation(result: &SidecarWorkspaceEditResult) -> bool {
    result
        .document_changes
        .iter()
        .any(|document| document.create || document.rename_to.is_some())
}

/// Rename returns text edits only; resource operations fail with a reason.
/// [REFACTOR-NEVER-SILENT]
pub(super) fn ensure_rename_text_only(result: &SidecarWorkspaceEditResult) -> Result<()> {
    if contains_resource_operation(result) {
        anyhow::bail!("rename cannot create or rename files");
    }
    Ok(())
}

/// Reject invalid, overlapping, or conflicting edits in every document.
pub(super) fn validate_workspace_edits(result: &SidecarWorkspaceEditResult) -> Result<()> {
    for document in &result.document_changes {
        validate_rename_edits(&document.file_path, &document.edits)?;
    }
    Ok(())
}

/// Reject invalid or overlapping replacement ranges within one document.
pub(super) fn validate_rename_edits(path: &str, edits: &[SidecarTextEditResult]) -> Result<()> {
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
pub(super) fn rename_edits_overlap(
    left: &SidecarTextEditResult,
    right: &SidecarTextEditResult,
) -> bool {
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
pub(super) fn rename_edit_start(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.start_line, edit.start_character)
}

/// Return an edit's zero-based exclusive end position.
pub(super) fn rename_edit_end(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.end_line, edit.end_character)
}

/// Merge one normalized document into the accumulated result.
pub(super) fn merge_document_edit(
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
pub(super) fn normalize_rename_edits(edits: &mut Vec<SidecarTextEditResult>) {
    edits.sort_by(compare_rename_edits);
    edits.dedup_by(|right, left| same_rename_edit(left, right));
}

/// Compare rename edits in deterministic source order.
pub(super) fn compare_rename_edits(
    left: &SidecarTextEditResult,
    right: &SidecarTextEditResult,
) -> std::cmp::Ordering {
    rename_edit_key(left).cmp(&rename_edit_key(right))
}

/// Return the fields that uniquely identify a rename replacement.
pub(super) fn rename_edit_key(edit: &SidecarTextEditResult) -> (u32, u32, u32, u32, &str) {
    (
        edit.start_line,
        edit.start_character,
        edit.end_line,
        edit.end_character,
        edit.new_text.as_str(),
    )
}

/// Test whether two replacements target the same range with the same text.
pub(super) fn same_rename_edit(
    left: &SidecarTextEditResult,
    right: &SidecarTextEditResult,
) -> bool {
    rename_edit_key(left) == rename_edit_key(right)
}

/// Construct an empty sidecar workspace edit.
pub(super) fn empty_workspace_edit() -> SidecarWorkspaceEditResult {
    SidecarWorkspaceEditResult {
        document_changes: Vec::new(),
    }
}

/// Convert the merged sidecar result into an LSP workspace edit or `null`.
pub(super) fn workspace_edit_value(
    result: SidecarWorkspaceEditResult,
) -> Result<serde_json::Value> {
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
pub(super) fn lsp_document_edit(
    edit: SidecarDocumentEditResult,
) -> Result<lsp_types::TextDocumentEdit> {
    let uri = path_to_lsp_uri(&edit.file_path)?;
    let edits = edit.edits.into_iter().map(lsp_rename_edit).collect();
    Ok(lsp_types::TextDocumentEdit {
        text_document: lsp_types::OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits,
    })
}

/// Convert one sidecar rename replacement into an unannotated LSP text edit.
pub(super) fn lsp_rename_edit(
    edit: SidecarTextEditResult,
) -> OneOf<TextEdit, lsp_types::AnnotatedTextEdit> {
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
