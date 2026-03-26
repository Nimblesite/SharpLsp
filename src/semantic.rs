//! Semantic request handlers routed through the .NET sidecar.
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionParams, CompletionResponse, DocumentHighlight,
    DocumentHighlightKind, DocumentHighlightParams, GotoDefinitionParams, GotoDefinitionResponse,
    Hover, HoverContents, HoverParams, Location, MarkupContent, MarkupKind, Position, Range,
    ReferenceParams, Uri,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/completion` via the C# sidecar.
pub fn handle_completion(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: CompletionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position.text_document.uri)?;
    let line = params.text_document_position.position.line;
    let character = params.text_document_position.position.character;

    let request = SidecarCompletionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/completion", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar completion unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let items: Vec<SidecarCompletionItem> = rmp_serde::from_slice(&response_bytes)?;
    let lsp_items: Vec<CompletionItem> = items
        .into_iter()
        .map(|item| CompletionItem {
            label: item.label,
            kind: Some(map_completion_kind(&item.kind)),
            detail: item.detail,
            insert_text: item.insert_text,
            ..CompletionItem::default()
        })
        .collect();

    Ok(serde_json::to_value(CompletionResponse::Array(lsp_items))?)
}

/// Handle `textDocument/hover` via the C# sidecar.
pub fn handle_hover(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("Hover: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: HoverParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position_params.text_document.uri;
    let position = params.text_document_position_params.position;

    let file_path = uri_to_path(uri)?;
    debug!(
        file = %file_path,
        line = position.line,
        character = position.character,
        "Hover request dispatching to sidecar"
    );

    let request = SidecarPositionReq {
        file_path,
        line: position.line,
        character: position.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/hover", payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar hover unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let result: Option<SidecarHoverResult> = rmp_serde::from_slice(&response_bytes)?;
    let hover = result.map(|r| {
        let range = build_hover_range(&r);
        Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: r.contents,
            }),
            range,
        }
    });

    let value = serde_json::to_value(hover)?;
    Ok(value)
}

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
    let value =
        handle_multi_location_nav(req.clone(), runtime, sidecar, "textDocument/implementation")?;
    if is_empty_nav_result(&value) {
        if let Some(fb) = fallback {
            debug!("Cross-language fallback for textDocument/implementation");
            match handle_multi_location_nav(req, runtime, Some(fb), "textDocument/implementation") {
                Ok(fb_value) if !is_empty_nav_result(&fb_value) => return Ok(fb_value),
                Ok(_) => debug!("Cross-language fallback returned empty for implementation"),
                Err(err) => debug!("Cross-language fallback failed for implementation: {err:#}"),
            }
        }
    }
    Ok(value)
}

/// Handle `textDocument/references` with cross-language fallback.
pub fn handle_references(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let value = handle_references_nav(req.clone(), runtime, sidecar)?;
    if is_empty_nav_result(&value) {
        if let Some(fb) = fallback {
            debug!("Cross-language fallback for textDocument/references");
            match handle_references_nav(req, runtime, Some(fb)) {
                Ok(fb_value) if !is_empty_nav_result(&fb_value) => return Ok(fb_value),
                Ok(_) => debug!("Cross-language fallback returned empty for references"),
                Err(err) => debug!("Cross-language fallback failed for references: {err:#}"),
            }
        }
    }
    Ok(value)
}

/// Handle `textDocument/documentHighlight` via the sidecar.
pub fn handle_document_highlight(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("DocumentHighlight: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: DocumentHighlightParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position_params.text_document.uri)?;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;

    debug!(
        file = %file_path,
        line = line,
        character = character,
        "DocumentHighlight request dispatching to sidecar"
    );

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/documentHighlight", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar documentHighlight unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let result: SidecarDocumentHighlightListResult = rmp_serde::from_slice(&response_bytes)?;
    let highlights: Vec<DocumentHighlight> = result
        .highlights
        .into_iter()
        .map(|h| DocumentHighlight {
            range: Range::new(
                Position::new(h.start_line, h.start_character),
                Position::new(h.end_line, h.end_character),
            ),
            kind: Some(match h.kind {
                3 => DocumentHighlightKind::WRITE,
                2 => DocumentHighlightKind::READ,
                _ => DocumentHighlightKind::TEXT,
            }),
        })
        .collect();

    Ok(serde_json::to_value(highlights)?)
}

/// Inner handler for references (serializes `ReferencesRequest` with `include_declaration`).
fn handle_references_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("References: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: ReferenceParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position.text_document.uri)?;
    let line = params.text_document_position.position.line;
    let character = params.text_document_position.position.character;
    let include_declaration = params.context.include_declaration;

    debug!(
        file = %file_path,
        line = line,
        character = character,
        include_declaration = include_declaration,
        "References request dispatching to sidecar"
    );

    let request = SidecarReferencesReq {
        file_path,
        line,
        character,
        include_declaration,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("textDocument/references", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar references unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let result: SidecarLocationListResult = rmp_serde::from_slice(&response_bytes)?;
    let locations: Vec<Location> = result
        .locations
        .into_iter()
        .filter_map(|loc| sidecar_location_to_lsp(&loc))
        .collect();

    Ok(serde_json::to_value(locations)?)
}

// ── Shared Helpers ────────────────────────────────────────────────

/// Shared handler for multi-location navigation requests
/// (definition, implementation).
fn handle_multi_location_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("{method}: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: GotoDefinitionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position_params.text_document.uri)?;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;

    debug!(
        file = %file_path,
        line = line,
        character = character,
        "{method} request dispatching to sidecar"
    );

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request(method, payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar {method} unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let result: SidecarLocationListResult = rmp_serde::from_slice(&response_bytes)?;
    let locations: Vec<Location> = result
        .locations
        .into_iter()
        .filter_map(|loc| sidecar_location_to_lsp(&loc))
        .collect();

    if locations.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let response = GotoDefinitionResponse::Array(locations);
    Ok(serde_json::to_value(response)?)
}

/// Check if a navigation result is empty (null or empty array).
fn is_empty_nav_result(value: &serde_json::Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

/// Cached navigation with cross-language fallback.
///
/// Tries the primary sidecar first. If it returns empty/null,
/// retries with the fallback sidecar (cross-language C# ↔ F#).
/// If the fallback also fails (e.g. sidecar not running), returns
/// the original result without blocking.
#[expect(
    clippy::too_many_arguments,
    reason = "cross-language fallback requires both sidecars plus cached-nav params"
)]
fn handle_cached_nav_with_fallback(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
    method: &str,
    multi: bool,
) -> Result<serde_json::Value> {
    let value = handle_cached_nav(req.clone(), vfs, nav_cache, runtime, sidecar, method, multi)?;
    if is_empty_nav_result(&value) {
        if let Some(fb) = fallback {
            debug!("Cross-language fallback for {method}");
            match handle_cached_nav(req, vfs, nav_cache, runtime, Some(fb), method, multi) {
                Ok(fb_value) if !is_empty_nav_result(&fb_value) => return Ok(fb_value),
                Ok(_) => debug!("Cross-language fallback returned empty for {method}"),
                Err(err) => debug!("Cross-language fallback failed for {method}: {err:#}"),
            }
        }
    }
    Ok(value)
}

/// Cached navigation handler — checks cache before dispatching to sidecar.
///
/// `multi` controls whether to use multi-location (definition) or
/// single-location (typeDefinition, declaration) response format.
fn handle_cached_nav(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
    multi: bool,
) -> Result<serde_json::Value> {
    let params: GotoDefinitionParams = serde_json::from_value(req.params.clone())?;
    let uri = &params.text_document_position_params.text_document.uri;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;
    let version = vfs.get_version(uri).unwrap_or(0);

    if let Some(cached) = nav_cache.get(uri.as_str(), version, line, character, method) {
        debug!("{method} cache hit");
        return Ok(cached.clone());
    }

    let value = if multi {
        handle_multi_location_nav(req, runtime, sidecar, method)?
    } else {
        handle_single_location_nav(req, runtime, sidecar, method)?
    };

    nav_cache.insert(
        uri.as_str(),
        version,
        line,
        character,
        method,
        value.clone(),
    );
    Ok(value)
}

/// Shared handler for single-location navigation requests
/// (typeDefinition, declaration).
fn handle_single_location_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("{method}: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: GotoDefinitionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position_params.text_document.uri)?;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;

    debug!(
        file = %file_path,
        line = line,
        character = character,
        "{method} request dispatching to sidecar"
    );

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request(method, payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar {method} unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let result: SidecarLocationListResult = rmp_serde::from_slice(&response_bytes)?;
    let response = result.locations.first().and_then(|loc| {
        let location = sidecar_location_to_lsp(loc)?;
        Some(GotoDefinitionResponse::Scalar(location))
    });

    Ok(serde_json::to_value(response)?)
}

/// Convert a sidecar `LocationResult` to an LSP `Location`.
fn sidecar_location_to_lsp(loc: &SidecarLocationResult) -> Option<Location> {
    let path = format!("file://{}", loc.file_path);
    let uri: Uri = path.parse().ok()?;
    Some(Location {
        uri,
        range: Range::new(
            Position::new(loc.line, loc.character),
            Position::new(loc.end_line, loc.end_character),
        ),
    })
}

/// Build an LSP `Range` from optional sidecar hover coordinates.
fn build_hover_range(result: &SidecarHoverResult) -> Option<Range> {
    match (
        result.start_line,
        result.start_character,
        result.end_line,
        result.end_character,
    ) {
        (Some(sl), Some(sc), Some(el), Some(ec)) => {
            Some(Range::new(Position::new(sl, sc), Position::new(el, ec)))
        }
        _ => None,
    }
}

/// Convert a file URI to a filesystem path string.
pub(crate) fn uri_to_path(uri: &Uri) -> Result<String> {
    crate::utils::uri_to_path(uri.as_str())
}

/// Map a Roslyn completion tag to an LSP `CompletionItemKind`.
fn map_completion_kind(tag: &str) -> CompletionItemKind {
    match tag {
        "Class" => CompletionItemKind::CLASS,
        "Struct" => CompletionItemKind::STRUCT,
        "Interface" => CompletionItemKind::INTERFACE,
        "Enum" => CompletionItemKind::ENUM,
        "EnumMember" => CompletionItemKind::ENUM_MEMBER,
        "Method" | "ExtensionMethod" => CompletionItemKind::METHOD,
        "Property" => CompletionItemKind::PROPERTY,
        "Field" => CompletionItemKind::FIELD,
        "Event" => CompletionItemKind::EVENT,
        "Namespace" => CompletionItemKind::MODULE,
        "Keyword" => CompletionItemKind::KEYWORD,
        "Local" | "Parameter" | "RangeVariable" => CompletionItemKind::VARIABLE,
        "Constant" => CompletionItemKind::CONSTANT,
        "Delegate" => CompletionItemKind::FUNCTION,
        "TypeParameter" => CompletionItemKind::TYPE_PARAMETER,
        _ => CompletionItemKind::TEXT,
    }
}

// ── Sidecar wire types (MessagePack) ──────────────────────────────

#[derive(serde::Serialize)]
struct SidecarCompletionReq {
    file_path: String,
    line: u32,
    character: u32,
}

/// Notify the sidecar that a document's text has changed.
pub fn notify_did_change(
    file_path: &str,
    new_text: &str,
    runtime: &tokio::runtime::Runtime,
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
    runtime.spawn(async move {
        if let Err(err) = sidecar.request("textDocument/didChange", payload).await {
            debug!("Sidecar didChange failed: {err:#}");
        }
    });
}

#[derive(serde::Serialize)]
struct SidecarDidChangeReq {
    file_path: String,
    new_text: String,
}

#[derive(serde::Serialize)]
struct SidecarPositionReq {
    file_path: String,
    line: u32,
    character: u32,
}

#[derive(serde::Deserialize)]
struct SidecarCompletionItem {
    label: String,
    kind: String,
    detail: Option<String>,
    insert_text: Option<String>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SidecarHoverResult {
    contents: String,
    start_line: Option<u32>,
    start_character: Option<u32>,
    end_line: Option<u32>,
    end_character: Option<u32>,
}

#[derive(serde::Deserialize)]
struct SidecarLocationResult {
    file_path: String,
    line: u32,
    character: u32,
    end_line: u32,
    end_character: u32,
}

#[derive(serde::Deserialize)]
struct SidecarLocationListResult {
    locations: Vec<SidecarLocationResult>,
}

#[derive(serde::Serialize)]
struct SidecarReferencesReq {
    file_path: String,
    line: u32,
    character: u32,
    include_declaration: bool,
}

#[derive(serde::Deserialize)]
struct SidecarDocumentHighlightResult {
    start_line: u32,
    start_character: u32,
    end_line: u32,
    end_character: u32,
    kind: u32,
}

#[derive(serde::Deserialize)]
struct SidecarDocumentHighlightListResult {
    highlights: Vec<SidecarDocumentHighlightResult>,
}
