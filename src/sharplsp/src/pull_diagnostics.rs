//! LSP 3.17 document/workspace pulls. Implements [DIAG-LSP-PULL].

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use lsp_types::{DocumentDiagnosticParams, WorkspaceDiagnosticParams};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::paths;
use crate::sidecar::manager::SidecarManager;
use crate::vfs::Vfs;

pub(crate) mod changes;
pub(crate) mod events;
pub(crate) mod monitor;
pub(crate) mod requests;
pub(crate) mod state;

/// Source metadata; enumeration never eagerly compiles the solution.
#[derive(Deserialize)]
struct DiagnosticDocument {
    /// Native source path owned by the engine.
    file_path: String,
    /// Owning project name used by the scope filter.
    project_name: String,
    /// Owning native project path used by the scope filter.
    project_path: String,
}

/// Return full truth or an unchanged identity; failures remain request errors.
fn handle_document_diagnostic(
    req: Request,
    vfs: &Vfs,
    snapshot: &requests::Snapshot,
) -> Result<Value> {
    let params: DocumentDiagnosticParams = serde_json::from_value(req.params)?;
    document_report(
        params.text_document.uri.as_str(),
        params.previous_result_id.as_deref(),
        vfs.get_version_canonical(&params.text_document.uri),
        snapshot,
    )
}

/// Pull both engines, including unopened sources, and retire removed results.
fn handle_workspace_diagnostic(
    req: Request,
    runtime: &tokio::runtime::Handle,
    sidecars: [Option<&Arc<SidecarManager>>; 2],
    vfs: &Vfs,
    snapshot: &requests::Snapshot,
) -> Result<Value> {
    let params: WorkspaceDiagnosticParams = serde_json::from_value(req.params)?;
    let config = state::configuration()?;
    let documents = if config.solution_wide_analysis {
        let documents = runtime.block_on(documents(sidecars))?;
        snapshot.check()?;
        state::watch_documents(&documents, snapshot.revision)?;
        documents
    } else {
        Vec::new()
    };
    let filter = paths::project_glob_filter(&config.project_filter)?;
    let items = collect_reports(documents, filter.as_ref(), &params, vfs, snapshot)?;
    Ok(json!({ "items": items }))
}

/// Stream when requested; otherwise return one ordered, complete workspace report.
fn collect_reports(
    documents: Vec<DiagnosticDocument>,
    filter: Option<&globset::GlobSet>,
    params: &WorkspaceDiagnosticParams,
    vfs: &Vfs,
    snapshot: &requests::Snapshot,
) -> Result<Vec<Value>> {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    let workspace = state::workspace()?;
    for document in documents
        .into_iter()
        .filter(|document| project_matches(document, filter, workspace.as_deref()))
    {
        snapshot.check()?;
        let uri = paths::path_to_lsp_uri(&document.file_path)?;
        if seen.insert(paths::comparison_key(&document.file_path)) {
            let report = workspace_report(uri.as_str(), params, vfs, snapshot)?;
            if is_new_clean_project(&document.file_path, uri.as_str(), &report, params) {
                continue;
            }
            if let Some(token) = &params.partial_result_params.partial_result_token {
                snapshot.partial(token, &report)?;
            } else {
                items.push(report);
            }
        }
    }
    snapshot.check()?;
    retire_previous(params, &seen, &mut items, snapshot)?;
    Ok(items)
}

/// Document-level report shared by individual and workspace pulls.
fn document_report(
    uri: &str,
    previous: Option<&str>,
    version: Option<i32>,
    snapshot: &requests::Snapshot,
) -> Result<Value> {
    snapshot.check()?;
    let version = version.unwrap_or_default();
    let result_id = snapshot.store.result_id(version);
    if previous == Some(result_id.as_str()) {
        return Ok(json!({ "kind": "unchanged", "resultId": result_id }));
    }
    let report = snapshot.store.diagnostics(uri, version)?;
    if crate::diagnostics::has_restore_pending(report.items.as_ref()) {
        state::invalidate()?;
    }
    snapshot.check()?;
    Ok(json!({ "kind": "full", "resultId": report.result_id, "items": report.items.as_ref() }))
}

/// Add workspace URI/version fields to a per-document report.
fn workspace_report(
    uri: &str,
    params: &WorkspaceDiagnosticParams,
    vfs: &Vfs,
    snapshot: &requests::Snapshot,
) -> Result<Value> {
    let previous = previous_result_id(uri, params);
    let version = uri
        .parse()
        .ok()
        .and_then(|uri| vfs.get_version_canonical(&uri));
    let mut report = document_report(uri, previous, version, snapshot)?;
    let fields = report
        .as_object_mut()
        .context("diagnostic report must be an object")?;
    let _ = fields.insert("uri".to_owned(), json!(uri));
    let _ = fields.insert("version".to_owned(), json!(version));
    Ok(report)
}

/// One identity lookup for both source and project reports.
fn previous_result_id<'a>(uri: &str, params: &'a WorkspaceDiagnosticParams) -> Option<&'a str> {
    params
        .previous_result_ids
        .iter()
        .find(|previous| paths::same_uri(previous.uri.as_str(), uri))
        .map(|previous| previous.value.as_str())
}

/// New clean projects need no editor entry; previous project errors must still be retired.
fn is_new_clean_project(
    path: &str,
    uri: &str,
    report: &Value,
    params: &WorkspaceDiagnosticParams,
) -> bool {
    paths::has_extension(path, &["csproj", "fsproj"])
        && previous_result_id(uri, params).is_none()
        && report
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
}

/// Explicit empty reports retire diagnostics that left the active scope.
fn retire_previous(
    params: &WorkspaceDiagnosticParams,
    seen: &HashSet<String>,
    items: &mut Vec<Value>,
    snapshot: &requests::Snapshot,
) -> Result<()> {
    for previous in &params.previous_result_ids {
        let path = paths::uri_to_path(previous.uri.as_str())?;
        if !seen.contains(&paths::comparison_key(&path)) {
            items.push(
                json!({ "uri": previous.uri.as_str(), "version": null, "kind": "full",
                "resultId": snapshot.store.result_id(0), "items": [] }),
            );
        }
    }
    Ok(())
}

/// Metadata only, without the old eager get-all or simulated verification pass.
async fn documents(sidecars: [Option<&Arc<SidecarManager>>; 2]) -> Result<Vec<DiagnosticDocument>> {
    let mut documents = Vec::new();
    for sidecar in sidecars.into_iter().flatten() {
        documents.extend(engine_documents(sidecar).await?);
    }
    Ok(documents)
}

/// Source and project metadata define input scope independently of rendered diagnostics.
fn document_roots(documents: &[DiagnosticDocument]) -> Vec<std::path::PathBuf> {
    paths::diagnostic_watch_roots(
        documents
            .iter()
            .flat_map(|document| [document.file_path.as_str(), document.project_path.as_str()]),
    )
}

/// Preserve the source-only metadata RPC and enumerate project identities separately.
async fn engine_documents(sidecar: &SidecarManager) -> Result<Vec<DiagnosticDocument>> {
    let mut documents = Vec::new();
    for method in [
        "workspace/diagnostics/documents",
        "workspace/diagnostics/projects",
    ] {
        let payload = sidecar.request(method, rmp_serde::to_vec(&())?).await?;
        documents.extend(
            rmp_serde::from_slice::<Vec<DiagnosticDocument>>(&payload)
                .context("decode diagnostic metadata")?,
        );
    }
    Ok(documents)
}

/// Reuse metadata-only enumeration for the legacy gated push fallback.
pub async fn paths_for_sidecar(
    sidecar: &SidecarManager,
    patterns: &[String],
) -> Result<Vec<String>> {
    let documents = engine_documents(sidecar).await?;
    let filter = paths::project_glob_filter(patterns)?;
    let workspace = state::workspace()?;
    Ok(documents
        .into_iter()
        .filter(|document| project_matches(document, filter.as_ref(), workspace.as_deref()))
        .map(|document| document.file_path)
        .collect())
}

/// Workspace-only project filtering leaves individual document pulls intact.
fn project_matches(
    document: &DiagnosticDocument,
    filter: Option<&globset::GlobSet>,
    workspace: Option<&str>,
) -> bool {
    filter.is_none_or(|filter| {
        paths::project_matches_globs(
            filter,
            &document.project_name,
            &document.project_path,
            workspace,
        )
    })
}
