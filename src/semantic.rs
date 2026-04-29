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
    Hover, HoverContents, HoverParams, Location, MarkupContent, MarkupKind, OneOf, Position,
    PrepareRenameResponse, Range, ReferenceParams, RenameParams, TextDocumentPositionParams,
    TextEdit, Uri, WorkspaceEdit,
};
use tracing::{debug, info, warn};

use crate::sidecar::manager::SidecarManager;

/// Handle `textDocument/completion` via the .NET sidecar + postfix templates.
pub fn handle_completion(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    vfs: &crate::vfs::Vfs,
) -> Result<serde_json::Value> {
    let params: CompletionParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position.text_document.uri;
    let file_path = uri_to_path(uri)?;
    let line = params.text_document_position.position.line;
    let character = params.text_document_position.position.character;

    // Collect postfix completion items from VFS document text.
    let mut lsp_items: Vec<CompletionItem> = Vec::new();
    if let Some(source) = vfs.get_content(uri) {
        if let Some(lang) = crate::tree_sitter_parse::LangId::from_uri(uri) {
            let postfix =
                crate::postfix_completion::get_postfix_completions(&source, line, character, lang);
            lsp_items.extend(postfix);
        }
    }

    // Fetch sidecar completions.
    if let Some(sidecar) = sidecar {
        let request = SidecarCompletionReq {
            file_path,
            line,
            character,
        };
        let payload = rmp_serde::to_vec(&request)?;
        match runtime.block_on(sidecar.request("textDocument/completion", payload)) {
            Ok(response_bytes) => {
                let items: Vec<SidecarCompletionItem> = rmp_serde::from_slice(&response_bytes)?;
                let sidecar_items = items.into_iter().map(|item| {
                    let data = serde_json::json!({
                        "file_path": &request.file_path,
                        "index": item.index,
                    });
                    CompletionItem {
                        label: item.label,
                        kind: Some(map_completion_kind(&item.kind)),
                        detail: item.detail,
                        insert_text: item.insert_text,
                        data: Some(data),
                        ..CompletionItem::default()
                    }
                });
                lsp_items.extend(sidecar_items);
            }
            Err(err) => {
                warn!("Sidecar completion unavailable: {err:#}");
            }
        }
    }

    if lsp_items.is_empty() {
        return Ok(serde_json::Value::Null);
    }

    Ok(serde_json::to_value(CompletionResponse::Array(lsp_items))?)
}

/// Handle `completionItem/resolve` — fetches additional text edits (e.g. using directives).
pub fn handle_completion_resolve(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let mut item: CompletionItem = serde_json::from_value(req.params)?;
    let data = item.data.clone().unwrap_or_default();
    let file_path = data
        .get("file_path")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let index = data
        .get("index")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(-1);

    if file_path.is_empty() || index < 0 {
        return Ok(serde_json::to_value(item)?);
    }

    let request = SidecarCompletionResolveReq {
        file_path,
        index: i32::try_from(index).unwrap_or(-1),
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = match runtime.block_on(sidecar.request("completionItem/resolve", payload))
    {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar completion resolve unavailable: {err:#}");
            return Ok(serde_json::to_value(item)?);
        }
    };

    let result: SidecarCompletionResolveResult = rmp_serde::from_slice(&response_bytes)?;
    if !result.additional_edits.is_empty() {
        item.additional_text_edits = Some(
            result
                .additional_edits
                .into_iter()
                .map(|e| TextEdit {
                    range: Range::new(
                        Position::new(e.start_line, e.start_character),
                        Position::new(e.end_line, e.end_character),
                    ),
                    new_text: e.new_text,
                })
                .collect(),
        );
    }

    Ok(serde_json::to_value(item)?)
}

/// Handle `textDocument/hover` via the C# sidecar, with caching.
pub fn handle_hover(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        warn!("Hover: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: HoverParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position_params.text_document.uri;
    let position = params.text_document_position_params.position;
    let version = vfs.get_version(uri).unwrap_or(0);
    let method = "textDocument/hover";

    if let Some(cached) = nav_cache.get(
        uri.as_str(),
        version,
        position.line,
        position.character,
        method,
    ) {
        info!("Hover cache hit");
        return Ok(cached.clone());
    }

    let file_path = uri_to_path(uri)?;
    info!(
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
    let response_bytes = match runtime.block_on(sidecar.request(method, payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar hover unavailable: {err:#}");
            return Ok(serde_json::Value::Null);
        }
    };

    let result: Option<SidecarHoverResult> = rmp_serde::from_slice(&response_bytes)?;
    let has_content = result.is_some();
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

    if has_content {
        info!(file = uri.as_str(), "Hover: sidecar returned content");
    } else {
        info!(file = uri.as_str(), "Hover: sidecar returned null");
    }

    let value = serde_json::to_value(hover)?;
    nav_cache.insert(
        uri.as_str(),
        version,
        position.line,
        position.character,
        method,
        value.clone(),
    );
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

/// Handle `textDocument/references` with caching and cross-language fallback.
pub fn handle_references(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: ReferenceParams = serde_json::from_value(req.params.clone())?;
    let uri = &params.text_document_position.text_document.uri;
    let line = params.text_document_position.position.line;
    let character = params.text_document_position.position.character;
    let include_decl = params.context.include_declaration;
    let version = vfs.get_version(uri).unwrap_or(0);
    let cache_method = if include_decl {
        "textDocument/references:decl"
    } else {
        "textDocument/references:nodecl"
    };

    if let Some(cached) = nav_cache.get(uri.as_str(), version, line, character, cache_method) {
        debug!("References cache hit");
        return Ok(cached.clone());
    }

    let value = handle_references_nav(req.clone(), runtime, sidecar)?;
    let value = if is_empty_nav_result(&value) {
        if let Some(fb) = fallback {
            debug!("Cross-language fallback for textDocument/references");
            match handle_references_nav(req, runtime, Some(fb)) {
                Ok(fb_value) if !is_empty_nav_result(&fb_value) => fb_value,
                Ok(_) => {
                    debug!("Cross-language fallback returned empty for references");
                    value
                }
                Err(err) => {
                    debug!("Cross-language fallback failed for references: {err:#}");
                    value
                }
            }
        } else {
            value
        }
    } else {
        value
    };

    nav_cache.insert(
        uri.as_str(),
        version,
        line,
        character,
        cache_method,
        value.clone(),
    );
    Ok(value)
}

/// Handle `textDocument/documentHighlight` with caching via the sidecar.
pub fn handle_document_highlight(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: DocumentHighlightParams = serde_json::from_value(req.params.clone())?;
    let uri = &params.text_document_position_params.text_document.uri;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;
    let version = vfs.get_version(uri).unwrap_or(0);
    let method = "textDocument/documentHighlight";

    if let Some(cached) = nav_cache.get(uri.as_str(), version, line, character, method) {
        debug!("DocumentHighlight cache hit");
        return Ok(cached.clone());
    }

    let value = dispatch_document_highlight(req, runtime, sidecar)?;
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

/// Dispatch document highlight request to the sidecar.
fn dispatch_document_highlight(
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

    let response = (!locations.is_empty()).then(|| GotoDefinitionResponse::Array(locations));
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

/// Sidecar request for text completions at a given position.
#[derive(serde::Serialize)]
struct SidecarCompletionReq {
    /// Absolute filesystem path of the document.
    file_path: String,
    /// Zero-based line number.
    line: u32,
    /// Zero-based character offset.
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
    drop(runtime.spawn(async move {
        if let Err(err) = sidecar.request("textDocument/didChange", payload).await {
            debug!("Sidecar didChange failed: {err:#}");
        }
    }));
}

/// Sidecar notification payload for document content changes.
#[derive(serde::Serialize)]
pub(crate) struct SidecarDidChangeReq {
    /// Absolute filesystem path of the changed document.
    pub(crate) file_path: String,
    /// Full replacement text of the document.
    pub(crate) new_text: String,
}

/// Sidecar request for a position-based query (hover, definition, etc.).
#[derive(serde::Serialize)]
struct SidecarPositionReq {
    /// Absolute filesystem path of the document.
    file_path: String,
    /// Zero-based line number.
    line: u32,
    /// Zero-based character offset.
    character: u32,
}

/// A single completion item returned by the sidecar.
#[derive(serde::Deserialize)]
struct SidecarCompletionItem {
    /// Display label for the completion.
    label: String,
    /// Roslyn completion tag (e.g. "Class", "Method").
    kind: String,
    /// Optional detail text shown alongside the label.
    detail: Option<String>,
    /// Optional text to insert (may differ from label).
    insert_text: Option<String>,
    /// Sidecar-internal index used for resolve requests.
    index: i32,
}

/// Sidecar request to resolve additional details for a completion item.
#[derive(serde::Serialize)]
struct SidecarCompletionResolveReq {
    /// Absolute filesystem path of the document.
    file_path: String,
    /// Sidecar-internal index identifying the completion item.
    index: i32,
}

/// Sidecar response containing additional text edits for a resolved completion.
#[derive(serde::Deserialize)]
struct SidecarCompletionResolveResult {
    /// Additional edits to apply (e.g. adding `using` directives).
    additional_edits: Vec<SidecarTextEdit>,
}

/// A text edit returned by the sidecar (flat coordinate representation).
#[derive(serde::Deserialize)]
struct SidecarTextEdit {
    /// Start line of the edit range.
    start_line: u32,
    /// Start character of the edit range.
    start_character: u32,
    /// End line of the edit range.
    end_line: u32,
    /// End character of the edit range.
    end_character: u32,
    /// Replacement text.
    new_text: String,
}

/// Sidecar hover response with optional range coordinates.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SidecarHoverResult {
    /// Markdown-formatted hover content.
    contents: String,
    /// Optional start line of the hovered symbol.
    start_line: Option<u32>,
    /// Optional start character of the hovered symbol.
    start_character: Option<u32>,
    /// Optional end line of the hovered symbol.
    end_line: Option<u32>,
    /// Optional end character of the hovered symbol.
    end_character: Option<u32>,
}

/// A single location result from the sidecar (definition, references, etc.).
#[derive(serde::Deserialize)]
struct SidecarLocationResult {
    /// Absolute filesystem path of the target file.
    file_path: String,
    /// Start line of the target range.
    line: u32,
    /// Start character of the target range.
    character: u32,
    /// End line of the target range.
    end_line: u32,
    /// End character of the target range.
    end_character: u32,
}

/// Sidecar response containing a list of locations.
#[derive(serde::Deserialize)]
struct SidecarLocationListResult {
    /// The resolved locations.
    locations: Vec<SidecarLocationResult>,
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

// ── Rename ────────────────────────────────────────────────────────

// Implements [RENAME-PREPARE]

/// Handle `textDocument/prepareRename` via the sidecar.
pub fn handle_prepare_rename(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };

    let params: TextDocumentPositionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document.uri)?;
    let request = SidecarPositionReq {
        file_path,
        line: params.position.line,
        character: params.position.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        runtime.block_on(sidecar.request("textDocument/prepareRename", payload))?;
    let result: SidecarPrepareRenameResult = rmp_serde::from_slice(&response_bytes)?;

    if !result.can_rename {
        return Ok(serde_json::Value::Null);
    }

    let range = Range {
        start: Position {
            line: result.start_line,
            character: result.start_character,
        },
        end: Position {
            line: result.end_line,
            character: result.end_character,
        },
    };
    let response = PrepareRenameResponse::RangeWithPlaceholder {
        range,
        placeholder: result.placeholder,
    };
    Ok(serde_json::to_value(response)?)
}

// Implements [RENAME-APPLY]

/// Handle `textDocument/rename` via the sidecar.
pub fn handle_rename(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };

    let params: RenameParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(&params.text_document_position.text_document.uri)?;
    let request = SidecarRenameRequest {
        file_path,
        line: params.text_document_position.position.line,
        character: params.text_document_position.position.character,
        new_name: params.new_name,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = runtime.block_on(sidecar.request("textDocument/rename", payload))?;
    let result: SidecarWorkspaceEditResult = rmp_serde::from_slice(&response_bytes)?;

    let document_changes: Vec<lsp_types::TextDocumentEdit> = result
        .document_changes
        .into_iter()
        .filter_map(|doc_edit| {
            let uri = path_to_uri(&doc_edit.file_path).ok()?;
            let edits: Vec<OneOf<TextEdit, lsp_types::AnnotatedTextEdit>> = doc_edit
                .edits
                .into_iter()
                .map(|e| {
                    OneOf::Left(TextEdit {
                        range: Range {
                            start: Position {
                                line: e.start_line,
                                character: e.start_character,
                            },
                            end: Position {
                                line: e.end_line,
                                character: e.end_character,
                            },
                        },
                        new_text: e.new_text,
                    })
                })
                .collect();
            Some(lsp_types::TextDocumentEdit {
                text_document: lsp_types::OptionalVersionedTextDocumentIdentifier {
                    uri,
                    version: None,
                },
                edits,
            })
        })
        .collect();

    if document_changes.is_empty() {
        return Ok(serde_json::Value::Null);
    }

    let workspace_edit = WorkspaceEdit {
        document_changes: Some(lsp_types::DocumentChanges::Edits(document_changes)),
        ..WorkspaceEdit::default()
    };
    Ok(serde_json::to_value(workspace_edit)?)
}

/// Convert a filesystem path to a `file://` URI.
fn path_to_uri(path: &str) -> Result<Uri> {
    let uri_str = if path.starts_with('/') {
        format!("file://{path}")
    } else {
        format!("file:///{path}")
    };
    uri_str.parse::<Uri>().map_err(|e| anyhow::anyhow!("{e}"))
}

/// Sidecar request to rename a symbol.
#[derive(serde::Serialize)]
struct SidecarRenameRequest {
    /// Absolute path to the file containing the symbol.
    file_path: String,
    /// Zero-based line of the symbol.
    line: u32,
    /// Zero-based character offset of the symbol.
    character: u32,
    /// New name for the symbol.
    new_name: String,
}

/// Sidecar response indicating whether a symbol is renameable.
#[derive(serde::Deserialize)]
struct SidecarPrepareRenameResult {
    /// Whether the symbol at the position can be renamed.
    can_rename: bool,
    /// Start line of the symbol token.
    start_line: u32,
    /// Start character of the symbol token.
    start_character: u32,
    /// End line of the symbol token.
    end_line: u32,
    /// End character of the symbol token.
    end_character: u32,
    /// Current name of the symbol (used as the rename placeholder).
    placeholder: String,
}

/// A single text replacement from the sidecar.
#[derive(serde::Deserialize)]
struct SidecarTextEditResult {
    /// Start line of the range to replace.
    start_line: u32,
    /// Start character of the range to replace.
    start_character: u32,
    /// End line of the range to replace.
    end_line: u32,
    /// End character of the range to replace.
    end_character: u32,
    /// Replacement text.
    new_text: String,
}

/// Edits to a single document from the sidecar.
#[derive(serde::Deserialize)]
struct SidecarDocumentEditResult {
    /// Absolute path to the file.
    file_path: String,
    /// Text edits to apply.
    edits: Vec<SidecarTextEditResult>,
}

/// A workspace-wide set of edits from the sidecar rename operation.
#[derive(serde::Deserialize)]
struct SidecarWorkspaceEditResult {
    /// Per-document edits.
    document_changes: Vec<SidecarDocumentEditResult>,
}
