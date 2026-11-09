//! Semantic request handlers routed through the .NET sidecar.
//! Navigation requests implement [DEFINITION-ROUTING].
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

pub(crate) mod completion;
pub(crate) mod hover;
mod navigation;
pub(crate) mod rename;

use navigation::{
    cached_at_position, handle_cached_nav_with_fallback, handle_multi_location_nav, or_fallback,
    NavRoute,
};

use rename::SidecarRenameIdentityResult;

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, Location, Position, Range,
    ReferenceParams, Uri,
};
use tracing::{debug, warn};

use crate::paths::path_to_lsp_uri;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarPositionReq};

/// Handle `textDocument/definition` — tries primary sidecar, falls back to
/// the other for cross-language navigation (C# ↔ F#).
pub fn handle_definition(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_cached_nav_with_fallback(
        req,
        vfs,
        nav_cache,
        runtime,
        sidecar,
        fallback,
        "textDocument/definition",
        true,
    )
}

/// Handle `textDocument/typeDefinition` with cross-language fallback.
pub fn handle_type_definition(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_cached_nav_with_fallback(
        req,
        vfs,
        nav_cache,
        runtime,
        sidecar,
        fallback,
        "textDocument/typeDefinition",
        false,
    )
}

/// Handle `textDocument/declaration` with cross-language fallback.
pub fn handle_declaration(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_cached_nav_with_fallback(
        req,
        vfs,
        nav_cache,
        runtime,
        sidecar,
        fallback,
        "textDocument/declaration",
        false,
    )
}

/// Handle `textDocument/implementation` with cross-language fallback.
pub fn handle_implementation(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let method = "textDocument/implementation";
    let (value, _) = handle_multi_location_nav(req.clone(), runtime, (sidecar, fallback), method)?;
    Ok(or_fallback(value, fallback, method, |fb| {
        handle_multi_location_nav(req, runtime, (Some(fb), None), method).map(|(value, _)| value)
    }))
}

/// Handle `textDocument/references` with caching and cross-language fallback. [REFERENCES-ROUTING]
pub fn handle_references(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: ReferenceParams = serde_json::from_value(req.params.clone())?;
    let cache_method = if params.context.include_declaration {
        "textDocument/references:decl"
    } else {
        "textDocument/references:nodecl"
    };
    cached_at_position(req, vfs, nav_cache, cache_method, |req| {
        let value = handle_references_nav(req.clone(), runtime, (sidecar, fallback))?;
        Ok(or_fallback(
            value,
            fallback,
            "textDocument/references",
            |fb| handle_references_nav(req, runtime, (Some(fb), None)),
        ))
    })
}

/// Handle `textDocument/documentHighlight` with caching via the sidecar.
pub fn handle_document_highlight(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    cached_at_position(
        req,
        vfs,
        nav_cache,
        "textDocument/documentHighlight",
        |req| dispatch_document_highlight(req, runtime, sidecar),
    )
}

/// Dispatch document highlight request to the sidecar.
fn dispatch_document_highlight(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: DocumentHighlightParams| {
        let at = &params.text_document_position_params;
        let request = SidecarPositionReq::at(&at.text_document.uri, at.position)?;
        debug!(
            file = %request.file_path,
            line = request.line,
            character = request.character,
            "DocumentHighlight request dispatching to sidecar"
        );
        let method = "textDocument/documentHighlight";
        let Some(result) = request_sidecar::<SidecarDocumentHighlightListResult, _>(
            runtime, sidecar, method, &request,
        )?
        else {
            return Ok(serde_json::Value::Null);
        };
        let highlights: Vec<DocumentHighlight> = result
            .highlights
            .iter()
            .map(to_document_highlight)
            .collect();
        Ok(serde_json::to_value(highlights)?)
    })
}

/// One sidecar highlight as an LSP `DocumentHighlight`; kind 3 writes, 2 reads.
fn to_document_highlight(h: &SidecarDocumentHighlightResult) -> DocumentHighlight {
    DocumentHighlight {
        range: Range::new(
            Position::new(h.start_line, h.start_character),
            Position::new(h.end_line, h.end_character),
        ),
        kind: Some(match h.kind {
            3 => DocumentHighlightKind::WRITE,
            2 => DocumentHighlightKind::READ,
            _ => DocumentHighlightKind::TEXT,
        }),
    }
}

/// Inner handler for references (serializes `ReferencesRequest` with `include_declaration`).
/// References from the sidecar that owns the document, merged with the other
/// language's uses of the same symbol, found by its identity.
/// [REFERENCES-CROSS-LANGUAGE]
fn handle_references_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    (sidecar, other): NavRoute<'_>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: ReferenceParams| {
        let at = SidecarPositionReq::at(
            &params.text_document_position.text_document.uri,
            params.text_document_position.position,
        )?;
        let include_declaration = params.context.include_declaration;
        let Some(own) = own_references(runtime, sidecar, &at, include_declaration)? else {
            return Ok(serde_json::Value::Null);
        };
        let foreign = crate::cross_language::foreign_references(
            runtime,
            sidecar,
            other,
            &at,
            include_declaration,
        );
        Ok(serde_json::to_value(crate::cross_language::merged(
            own, foreign,
        ))?)
    })
}

/// The owning sidecar's references for the symbol at `at`; `None` when it
/// could not answer, which is the whole request's `null`.
fn own_references(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    at: &SidecarPositionReq,
    include_declaration: bool,
) -> Result<Option<Vec<Location>>> {
    debug!(
        file = %at.file_path,
        line = at.line,
        character = at.character,
        include_declaration,
        "References request dispatching to sidecar"
    );
    let request = SidecarReferencesReq {
        file_path: at.file_path.clone(),
        line: at.line,
        character: at.character,
        include_declaration,
    };
    let method = "textDocument/references";
    let result: Option<SidecarLocationListResult> =
        request_sidecar(runtime, sidecar, method, &request)?;
    Ok(result.map(|found| {
        found
            .locations
            .iter()
            .filter_map(sidecar_location_to_lsp)
            .collect()
    }))
}

/// Convert a sidecar `LocationResult` to an LSP `Location`.
pub(crate) fn sidecar_location_to_lsp(loc: &SidecarLocationResult) -> Option<Location> {
    let uri: Uri = path_to_lsp_uri(&loc.file_path).ok()?;
    Some(Location {
        uri,
        range: Range::new(
            Position::new(loc.line, loc.character),
            Position::new(loc.end_line, loc.end_character),
        ),
    })
}

// ── Sidecar wire types (MessagePack) ──────────────────────────────

/// Notify the sidecar that a document's text has changed.
pub fn notify_did_change(
    file_path: &str,
    new_text: &str,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) {
    runtime.block_on(notify_did_change_async(file_path, new_text, sidecar));
}

/// Async core of [`notify_did_change`], reused by the background reload pass.
pub async fn notify_did_change_async(
    file_path: &str,
    new_text: &str,
    sidecar: Option<&Arc<SidecarManager>>,
) {
    let Some(sidecar) = sidecar else { return };
    let request = SidecarDidChangeReq {
        file_path: file_path.to_string(),
        new_text: new_text.to_string(),
    };
    let Ok(payload) = rmp_serde::to_vec(&request) else {
        warn!("Failed to serialize didChange request");
        return;
    };
    let sidecar = Arc::clone(sidecar);
    if let Err(err) = sidecar.request("textDocument/didChange", payload).await {
        debug!("Sidecar didChange failed: {err:#}");
    }
}

/// Sidecar notification payload for document content changes.
#[derive(serde::Serialize)]
pub(crate) struct SidecarDidChangeReq {
    /// Absolute filesystem path of the changed document.
    pub(crate) file_path: String,
    /// Full replacement text of the document.
    pub(crate) new_text: String,
}

/// A single location result from the sidecar (definition, references, etc.).
#[derive(serde::Deserialize)]
pub(crate) struct SidecarLocationResult {
    /// Absolute filesystem path of the target file.
    file_path: String,
    /// Start line of the target range.
    pub(crate) line: u32,
    /// Start character of the target range.
    pub(crate) character: u32,
    /// End line of the target range.
    pub(crate) end_line: u32,
    /// End character of the target range.
    pub(crate) end_character: u32,
    /// For decompiled source of an F# project's symbol, the symbol's identity,
    /// which the F# sidecar places. [DEFINITION-CROSSLANG-IDENTITY]
    #[serde(default)]
    pub(crate) symbol: Option<SidecarRenameIdentityResult>,
}

/// Sidecar response containing a list of locations.
#[derive(serde::Deserialize)]
pub(crate) struct SidecarLocationListResult {
    /// The resolved locations.
    pub(crate) locations: Vec<SidecarLocationResult>,
}

/// Sidecar request for find-references at a given position.
#[derive(serde::Serialize)]
struct SidecarReferencesReq {
    /// Absolute filesystem path of the document.
    file_path: String,
    /// Zero-based line number.
    line: u32,
    /// Zero-based character offset.
    character: u32,
    /// Whether to include the declaration itself in results.
    include_declaration: bool,
}

/// A single document highlight from the sidecar.
#[derive(serde::Deserialize)]
struct SidecarDocumentHighlightResult {
    /// Start line of the highlighted range.
    start_line: u32,
    /// Start character of the highlighted range.
    start_character: u32,
    /// End line of the highlighted range.
    end_line: u32,
    /// End character of the highlighted range.
    end_character: u32,
    /// Highlight kind (1=text, 2=read, 3=write).
    kind: u32,
}

/// Sidecar response containing a list of document highlights.
#[derive(serde::Deserialize)]
struct SidecarDocumentHighlightListResult {
    /// The resolved highlights.
    highlights: Vec<SidecarDocumentHighlightResult>,
}
