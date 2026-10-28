//! `sharplsp/project/addCompileItem` — insert a `<Compile>` item at a chosen
//! position in an `MSBuild` project's compile order (GitHub #493,
//! [SE-ADD-FILE-REQUEST]) — and `sharplsp/project/removeCompileItem`, which
//! takes one out ([SE-REMOVE-FILE-REQUEST]).
//!
//! In F# compile ORDER matters, so new source files must land where the user
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

use crate::nuget::edit::{self, CompilePosition, EditOutcome};
use crate::nuget::handlers::EDITOR_UNAVAILABLE;
use crate::sidecar::manager::SidecarManager;

/// Parameters for the `sharplsp/project/addCompileItem` request.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCompileItemParams {
    /// Absolute path of the `.csproj` / `.fsproj` to edit.
    pub project_path: String,
    /// Project-relative include of the new source file.
    pub include: String,
    /// Existing Compile include to anchor to (absent for the default position).
    #[serde(default)]
    pub anchor_include: Option<String>,
    /// `before` | `after` the anchor, or absent/`default` for the last-item rule.
    #[serde(default)]
    pub position: Option<String>,
}

/// Response for the `sharplsp/project/addCompileItem` request.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCompileItemResponse {
    /// Whether the insert (or no-op) completed through the sidecar.
    pub success: bool,
    /// Human-readable status message.
    pub message: String,
    /// Whether the project file actually changed on disk.
    pub modified: bool,
}

/// Handle `sharplsp/project/addCompileItem` — route the edit to the C# sidecar.
pub fn handle_add_compile_item(
    req: Request,
    runtime: &Runtime,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<Value> {
    let params: AddCompileItemParams = serde_json::from_value(req.params)?;
    info!(
        project = %params.project_path,
        include = %params.include,
        position = params.position.as_deref().unwrap_or("default"),
        "Handling sharplsp/project/addCompileItem"
    );

    let response = match csharp {
        None => unavailable_response(),
        Some(sidecar) => apply(sidecar, runtime, &params),
    };
    Ok(serde_json::to_value(response)?)
}

/// Run the sidecar edit and shape the response; failures become unsuccessful
/// responses carrying the message, never protocol errors.
fn apply(
    sidecar: &Arc<SidecarManager>,
    runtime: &Runtime,
    params: &AddCompileItemParams,
) -> AddCompileItemResponse {
    respond(
        "addCompileItem",
        &params.project_path,
        &params.include,
        || {
            edit::add_compile_item(
                sidecar,
                runtime,
                &params.project_path,
                &params.include,
                params.anchor_include.as_deref().unwrap_or(""),
                CompilePosition::parse(params.position.as_deref()),
            )
        },
    )
}

/// Time `run`, log its outcome as `operation`, and shape the response.
fn respond(
    operation: &str,
    project: &str,
    include: &str,
    run: impl FnOnce() -> Result<EditOutcome>,
) -> AddCompileItemResponse {
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
            AddCompileItemResponse {
                success: true,
                message: outcome.message,
                modified: outcome.modified,
            }
        }
        Err(err) => {
            warn!(operation, project, include, ms = elapsed_ms(&started), error = %err, "compile item edit failed");
            AddCompileItemResponse {
                success: false,
                message: format!("{err:#}"),
                modified: false,
            }
        }
    }
}

/// Parameters for the `sharplsp/project/removeCompileItem` request.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveCompileItemParams {
    /// Absolute path of the `.csproj` / `.fsproj` to edit.
    pub project_path: String,
    /// Project-relative include of the source file to take out of compile order.
    pub include: String,
}

/// Handle `sharplsp/project/removeCompileItem`: the C# sidecar removes the
/// item through the `MSBuild` DOM; the source file itself is the editor's
/// to keep or delete. [SE-REMOVE-FILE-REQUEST]
pub fn handle_remove_compile_item(
    req: Request,
    runtime: &Runtime,
    csharp: Option<&Arc<SidecarManager>>,
) -> Result<Value> {
    let params: RemoveCompileItemParams = serde_json::from_value(req.params)?;
    info!(project = %params.project_path, include = %params.include, "Handling sharplsp/project/removeCompileItem");
    let response = match csharp {
        None => unavailable_response(),
        Some(sidecar) => respond(
            "removeCompileItem",
            &params.project_path,
            &params.include,
            || edit::remove_compile_item(sidecar, runtime, &params.project_path, &params.include),
        ),
    };
    Ok(serde_json::to_value(response)?)
}

/// The response when no C# sidecar is available to perform the `MSBuild` edit.
fn unavailable_response() -> AddCompileItemResponse {
    error!("compile item edit requested with no C# sidecar available");
    AddCompileItemResponse {
        success: false,
        message: EDITOR_UNAVAILABLE.to_string(),
        modified: false,
    }
}

/// Elapsed milliseconds since `started`, saturating rather than truncating.
fn elapsed_ms(started: &Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
