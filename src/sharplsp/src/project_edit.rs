//! Compile-item editing of an `MSBuild` project's compile order:
//! `sharplsp/project/addCompileItem` inserts a `<Compile>` item at a chosen
//! position (GitHub #493, [SE-ADD-FILE-REQUEST]), `removeCompileItem` takes one
//! out ([SE-REMOVE-FILE-REQUEST]) and `reorderCompileItems` moves one next to
//! an anchor ([SE-REORDER-FILE-REQUEST]).
//!
//! In F# compile ORDER matters, so source files must land where the user
//! asked: before/after a named anchor item, or by default before the LAST
//! `Compile` item so an F# entry point stays last ([SE-ADD-FILE-ORDER]). The XML
//! mutation is delegated to the C# sidecar's `MSBuild` document model — exactly
//! like the `NuGet` edits ([NUGET-XML-DOM]) — which is language-agnostic, so this
//! serves `.csproj` and `.fsproj` alike.

use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use lsp_server::Request;
use serde_json::Value;
use tokio::runtime::Runtime;
use tracing::{error, info, warn};

use crate::nuget::edit::{self, CompileEdit, CompilePosition, EditOutcome};
use crate::nuget::handlers::EDITOR_UNAVAILABLE;
use crate::sidecar::manager::SidecarManager;

/// Parameters of the compile-item requests; removal reads only the first two.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileItemParams {
    /// Absolute path of the `.csproj` / `.fsproj` to edit.
    pub project_path: String,
    /// Project-relative include of the source file the edit is about.
    pub include: String,
    /// Existing Compile include to anchor to (absent for the default position).
    #[serde(default)]
    pub anchor_include: Option<String>,
    /// `before` | `after` the anchor, or absent/`default` for the last-item rule.
    #[serde(default)]
    pub position: Option<String>,
}

/// Response of the compile-item requests.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileItemResponse {
    /// Whether the edit (or no-op) completed through the sidecar.
    pub success: bool,
    /// Human-readable status message.
    pub message: String,
    /// Whether the project file actually changed on disk.
    pub modified: bool,
}

/// The edit a `sharplsp/project/*` compile-item method asks for.
pub fn edit_for(method: &str) -> Option<CompileEdit> {
    match method {
        "sharplsp/project/addCompileItem" => Some(CompileEdit::Add),
        "sharplsp/project/removeCompileItem" => Some(CompileEdit::Remove),
        "sharplsp/project/reorderCompileItems" => Some(CompileEdit::Reorder),
        _ => None,
    }
}

/// Handle a compile-item request: the C# sidecar edits the project through the
/// `MSBuild` DOM; a removed source file itself is the editor's to keep or delete.
pub fn handle(
    req: Request,
    runtime: &Runtime,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<Value> {
    let kind = edit_for(&req.method).ok_or_else(|| anyhow::anyhow!("method not found"))?;
    let params: CompileItemParams = serde_json::from_value(req.params)?;
    info!(
        method = %req.method,
        project = %params.project_path,
        include = %params.include,
        position = params.position.as_deref().unwrap_or("default"),
        "Handling compile item edit"
    );
    let response = match csharp {
        None => unavailable_response(),
        Some(sidecar) => respond(&req.method, &params.project_path, &params.include, || {
            edit::compile_item_edit(
                sidecar,
                runtime,
                kind,
                &params.project_path,
                &params.include,
                params.anchor_include.as_deref().unwrap_or(""),
                CompilePosition::parse(params.position.as_deref()),
            )
        }),
    };
    Ok(serde_json::to_value(response)?)
}

/// Reload the compilers that own `project` now, not when the platform watcher
/// notices the write: on Windows it can miss the host's own edit, and the new
/// file stays unowned. [SE-ADD-FILE] [DIAG-LSP-REFRESH]
fn announce_written(project: &str) {
    if let Err(error) = crate::pull_diagnostics::monitor::written(&[project]) {
        warn!(project, error = %error, "edited project could not be announced for reload");
    }
}

/// Time `run`, log its outcome as `operation`, and shape the response.
fn respond(
    operation: &str,
    project: &str,
    include: &str,
    run: impl FnOnce() -> Result<EditOutcome>,
) -> CompileItemResponse {
    let started = Instant::now();
    match run() {
        Ok(outcome) => {
            info!(
                operation,
                project,
                include,
                modified = outcome.modified,
                ms = elapsed_ms(&started),
                "compile item edit complete"
            );
            if outcome.modified {
                announce_written(project);
            }
            CompileItemResponse {
                success: true,
                message: outcome.message,
                modified: outcome.modified,
            }
        }
        Err(err) => {
            warn!(operation, project, include, ms = elapsed_ms(&started), error = %err, "compile item edit failed");
            CompileItemResponse {
                success: false,
                message: format!("{err:#}"),
                modified: false,
            }
        }
    }
}

/// The response when no C# sidecar is available to perform the `MSBuild` edit.
fn unavailable_response() -> CompileItemResponse {
    error!("compile item edit requested with no C# sidecar available");
    CompileItemResponse {
        success: false,
        message: EDITOR_UNAVAILABLE.to_string(),
        modified: false,
    }
}

/// Elapsed milliseconds since `started`, saturating rather than truncating.
fn elapsed_ms(started: &Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
