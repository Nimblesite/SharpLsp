//! Wire DTOs shared between `code_actions` and the .NET sidecars.

use crate::utils::SidecarTextEdit;

/// Code action item returned by the sidecar.
#[derive(serde::Deserialize)]
pub(super) struct SidecarCodeActionItem {
    /// Server-side cache identifier for lazy resolution.
    pub(super) id: i32,
    /// Human-readable title displayed in the editor's code action menu.
    pub(super) title: String,
    /// Action kind string (e.g. "quickfix", "refactor.extract").
    pub(super) kind: String,
    /// Whether this action is the preferred fix for the diagnostic.
    pub(super) is_preferred: bool,
    /// The reference a command action adds before its import; `None` for an
    /// edit action. [REFACTOR-IMPORT-REFERENCE]
    #[serde(default)]
    pub(super) reference: Option<crate::import_command::SidecarReferenceImport>,
    /// The fix's stable identity (Roslyn `EquivalenceKey`), when the fix can run
    /// beyond its one occurrence. [FIXALL-SCOPES]
    #[serde(default)]
    pub(super) fix_key: Option<String>,
    /// The scopes ("document", "project", "solution") the fix's provider
    /// supports fixing every occurrence at. [FIXALL-SCOPES]
    #[serde(default)]
    pub(super) fix_all_scopes: Option<Vec<String>>,
}

/// Request sent to the sidecar to resolve a code action by ID.
#[derive(serde::Serialize)]
pub(super) struct SidecarCodeActionResolveReq {
    /// Identifier of the code action to resolve.
    pub(super) id: i32,
}

/// Request sent to the sidecar to run a fix at every occurrence of its scope:
/// a `(file_path, fix_key, scope)` positional `MessagePack` array matching the
/// sidecar's `FixAllRequest` Key layout. [FIXALL-SCOPES]
#[derive(serde::Serialize)]
pub(super) struct SidecarFixAllReq {
    /// Absolute path of the anchor document the fix was offered on.
    pub(super) file_path: String,
    /// The fix's equivalence key — never a title.
    pub(super) fix_key: String,
    /// The scope to fix at: document, project or solution.
    pub(super) scope: String,
}

/// Edits for a single document returned by the sidecar.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct SidecarDocumentEdit<T = SidecarTextEdit> {
    /// Absolute path of the file being edited.
    pub(crate) file_path: String,
    /// Text edits to apply to this document.
    pub(crate) edits: Vec<T>,
    /// Whether the edit creates the file, whose whole text it then holds.
    #[serde(default)]
    pub(crate) create: bool,
    /// The new absolute path when this edit renames the file.
    /// [REFACTOR-MOVE-TYPE-RENAME-FILE]
    #[serde(default)]
    pub(crate) rename_to: Option<String>,
}

/// A workspace-wide set of edits returned by the sidecar.
#[derive(serde::Deserialize, Clone)]
pub(crate) struct SidecarWorkspaceEdit<T = SidecarTextEdit> {
    /// Per-document edits that compose this workspace edit.
    pub(crate) document_changes: Vec<SidecarDocumentEdit<T>>,
}
