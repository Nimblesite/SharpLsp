//! Semantic request handlers routed through the .NET sidecar.
//! Navigation requests implement [DEFINITION-ROUTING].
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionParams, CompletionResponse, CompletionTextEdit,
    DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, GotoDefinitionParams,
    GotoDefinitionResponse, Hover, HoverContents, HoverParams, Location, MarkupContent, MarkupKind,
    OneOf, Position, PrepareRenameResponse, Range, ReferenceParams, RenameParams,
    TextDocumentPositionParams, TextEdit, Uri, WorkspaceEdit,
};
use tracing::{debug, info, warn};

use crate::nav_cache::is_empty_nav_result;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{map_text_edit, map_text_edits, SidecarTextEdit};

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
                        // A textEdit makes acceptance REPLACE the identifier span
                        // at the caret instead of appending it (GitHub #178).
                        // Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
                        text_edit: item
                            .text_edit
                            .as_ref()
                            .map(|edit| CompletionTextEdit::Edit(map_text_edit(edit))),
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
        item.additional_text_edits = Some(map_text_edits(&result.additional_edits));
    }

    Ok(serde_json::to_value(item)?)
}

/// Handle `textDocument/hover` via the language sidecar, with caching. [HOVER-ROUTING]
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

    if let Some(cached) = cached_nav_hit(
        nav_cache,
        uri.as_str(),
        version,
        line,
        character,
        cache_method,
        "References",
    ) {
        return Ok(cached);
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

    if let Some(cached) = cached_nav_hit(
        nav_cache,
        uri.as_str(),
        version,
        line,
        character,
        method,
        "DocumentHighlight",
    ) {
        return Ok(cached);
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

/// Dispatch a position-based navigation request to the sidecar and return the
/// raw location-list result. Returns `Ok(None)` — for which the caller should
/// yield JSON `null` — when no sidecar is connected or the sidecar call fails.
fn dispatch_position_request(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
) -> Result<Option<SidecarLocationListResult>> {
    let Some(sidecar) = sidecar else {
        debug!("{method}: no sidecar available");
        return Ok(None);
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
            return Ok(None);
        }
    };

    Ok(Some(rmp_serde::from_slice(&response_bytes)?))
}

/// Shared handler for multi-location navigation requests
/// (definition, implementation).
fn handle_multi_location_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
) -> Result<serde_json::Value> {
    let Some(result) = dispatch_position_request(req, runtime, sidecar, method)? else {
        return Ok(serde_json::Value::Null);
    };
    let locations: Vec<Location> = result
        .locations
        .into_iter()
        .filter_map(|loc| sidecar_location_to_lsp(&loc))
        .collect();

    let response = (!locations.is_empty()).then(|| GotoDefinitionResponse::Array(locations));
    Ok(serde_json::to_value(response)?)
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

/// Look up a navigation result in the cache, logging a hit under `label`.
///
/// Returns the cloned cached value on hit, or `None` when absent/stale.
fn cached_nav_hit(
    nav_cache: &crate::nav_cache::NavCache,
    uri: &str,
    version: i32,
    line: u32,
    character: u32,
    method: &str,
    label: &str,
) -> Option<serde_json::Value> {
    let cached = nav_cache.get(uri, version, line, character, method)?;
    debug!("{label} cache hit");
    Some(cached.clone())
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

    if let Some(cached) = cached_nav_hit(
        nav_cache,
        uri.as_str(),
        version,
        line,
        character,
        method,
        method,
    ) {
        return Ok(cached);
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
    let Some(result) = dispatch_position_request(req, runtime, sidecar, method)? else {
        return Ok(serde_json::Value::Null);
    };
    let response = result.locations.first().and_then(|loc| {
        let location = sidecar_location_to_lsp(loc)?;
        Some(GotoDefinitionResponse::Scalar(location))
    });

    Ok(serde_json::to_value(response)?)
}

/// Convert a sidecar `LocationResult` to an LSP `Location`.
fn sidecar_location_to_lsp(loc: &SidecarLocationResult) -> Option<Location> {
    let uri: Uri = crate::utils::path_to_lsp_uri(&loc.file_path).ok()?;
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
    if let Err(err) = runtime.block_on(sidecar.request("textDocument/didChange", payload)) {
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
    /// Edit that replaces the identifier span at the caret so acceptance does
    /// not append the member name to the trigger text (GitHub #178).
    /// Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
    text_edit: Option<SidecarTextEdit>,
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

// Implements [RENAME-APPLY] and [RENAME-CROSSLANGUAGE].

/// Handle `textDocument/rename` via the sidecar.
pub fn handle_rename(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: RenameParams = serde_json::from_value(req.params)?;
    let request = sidecar_rename_request(params)?;
    let result = request_workspace_edit(runtime, sidecar, "textDocument/rename", &request)?;
    let result = if result.document_changes.is_empty() {
        result
    } else {
        add_foreign_rename(runtime, sidecar, fallback, &request, result)
    };
    workspace_edit_value(result)
}

/// Convert LSP rename parameters into the sidecar's compact wire request.
fn sidecar_rename_request(params: RenameParams) -> Result<SidecarRenameRequest> {
    Ok(SidecarRenameRequest {
        file_path: uri_to_path(&params.text_document_position.text_document.uri)?,
        line: params.text_document_position.position.line,
        character: params.text_document_position.position.character,
        new_name: params.new_name,
    })
}

/// Append edits produced by the sidecar that owns the other language.
///
/// Enrichment is **best-effort**: the primary sidecar has already produced a
/// correct rename, so a crashed, restarting or wedged fallback sidecar must never
/// discard it. Any fault is logged and the primary edits are returned unchanged.
fn add_foreign_rename(
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
    result: SidecarWorkspaceEditResult,
) -> SidecarWorkspaceEditResult {
    match foreign_rename_edits(runtime, primary, fallback, request) {
        Ok(Some(foreign)) => merge_or_keep(result, foreign),
        Ok(None) => result,
        Err(err) => {
            warn!("Cross-language rename enrichment failed, keeping primary edits: {err:#}");
            result
        }
    }
}

/// Merge foreign edits in, falling back to the primary edits if the merge conflicts.
fn merge_or_keep(
    result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> SidecarWorkspaceEditResult {
    let primary = result.clone();
    match merge_workspace_edits(result, foreign) {
        Ok(merged) => merged,
        Err(err) => {
            warn!("Cross-language rename merge conflicted, keeping primary edits: {err:#}");
            primary
        }
    }
}

/// Ask the other-language sidecar for its edits, if it has a workspace that could hold any.
fn foreign_rename_edits(
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: Option<&Arc<SidecarManager>>,
    request: &SidecarRenameRequest,
) -> Result<Option<SidecarWorkspaceEditResult>> {
    let Some(fallback) = fallback else {
        return Ok(None);
    };
    if !sidecar_workspace_loaded(runtime, fallback)? {
        return Ok(None);
    }
    Ok(Some(request_foreign_rename(
        runtime, primary, fallback, request,
    )?))
}

/// Check whether the other-language sidecar has a project that can contain references.
fn sidecar_workspace_loaded(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
) -> Result<bool> {
    let bytes = runtime.block_on(sidecar.request("workspace/status", Vec::new()))?;
    let status: String = rmp_serde::from_slice(&bytes)?;
    match status.as_str() {
        "loaded" => Ok(true),
        "not_loaded" => Ok(false),
        other => anyhow::bail!("unexpected sidecar workspace status: {other}"),
    }
}

/// Resolve the primary symbol identity and ask the fallback for its references.
fn request_foreign_rename(
    runtime: &tokio::runtime::Runtime,
    primary: &Arc<SidecarManager>,
    fallback: &Arc<SidecarManager>,
    request: &SidecarRenameRequest,
) -> Result<SidecarWorkspaceEditResult> {
    let identity = request_rename_identity(runtime, primary, request)?;
    if !identity.found || identity.assembly_name.is_empty() || identity.xml_doc_sig.is_empty() {
        return Ok(empty_workspace_edit());
    }
    let foreign = SidecarForeignRenameRequest::new(identity, request.new_name.clone());
    request_workspace_edit(runtime, fallback, "workspace/renameForeign", &foreign)
}

/// Ask the owning sidecar for a portable assembly + XML-doc symbol identity.
fn request_rename_identity(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    rename: &SidecarRenameRequest,
) -> Result<SidecarRenameIdentityResult> {
    let request = SidecarPositionReq {
        file_path: rename.file_path.clone(),
        line: rename.line,
        character: rename.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let bytes = runtime.block_on(sidecar.request("textDocument/renameIdentity", payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Send a sidecar request whose response uses the workspace-edit wire shape.
fn request_workspace_edit<T: serde::Serialize>(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    method: &str,
    request: &T,
) -> Result<SidecarWorkspaceEditResult> {
    let payload = rmp_serde::to_vec(request)?;
    let bytes = runtime.block_on(sidecar.request(method, payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// Construct an empty sidecar workspace edit.
fn empty_workspace_edit() -> SidecarWorkspaceEditResult {
    SidecarWorkspaceEditResult {
        document_changes: Vec::new(),
    }
}

/// Convert the merged sidecar result into an LSP workspace edit or `null`.
fn workspace_edit_value(result: SidecarWorkspaceEditResult) -> Result<serde_json::Value> {
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
fn lsp_document_edit(edit: SidecarDocumentEditResult) -> Result<lsp_types::TextDocumentEdit> {
    let uri = crate::utils::path_to_lsp_uri(&edit.file_path)?;
    let edits = edit.edits.into_iter().map(lsp_rename_edit).collect();
    Ok(lsp_types::TextDocumentEdit {
        text_document: lsp_types::OptionalVersionedTextDocumentIdentifier { uri, version: None },
        edits,
    })
}

/// Convert one sidecar rename replacement into an unannotated LSP text edit.
fn lsp_rename_edit(edit: SidecarTextEditResult) -> OneOf<TextEdit, lsp_types::AnnotatedTextEdit> {
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

/// Merge fallback documents into the primary result and stabilize their order.
fn merge_workspace_edits(
    mut result: SidecarWorkspaceEditResult,
    foreign: SidecarWorkspaceEditResult,
) -> Result<SidecarWorkspaceEditResult> {
    result.document_changes.extend(foreign.document_changes);
    canonicalize_workspace_edit(result)
}

/// Merge duplicate document entries, normalize edit order, and reject conflicts.
fn canonicalize_workspace_edit(
    result: SidecarWorkspaceEditResult,
) -> Result<SidecarWorkspaceEditResult> {
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

/// Reject invalid, overlapping, or conflicting edits in every document.
fn validate_workspace_edits(result: &SidecarWorkspaceEditResult) -> Result<()> {
    for document in &result.document_changes {
        validate_rename_edits(&document.file_path, &document.edits)?;
    }
    Ok(())
}

/// Reject invalid or overlapping replacement ranges within one document.
fn validate_rename_edits(path: &str, edits: &[SidecarTextEditResult]) -> Result<()> {
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
fn rename_edits_overlap(left: &SidecarTextEditResult, right: &SidecarTextEditResult) -> bool {
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
fn rename_edit_start(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.start_line, edit.start_character)
}

/// Return an edit's zero-based exclusive end position.
fn rename_edit_end(edit: &SidecarTextEditResult) -> (u32, u32) {
    (edit.end_line, edit.end_character)
}

/// Merge one normalized document into the accumulated result.
fn merge_document_edit(
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
fn normalize_rename_edits(edits: &mut Vec<SidecarTextEditResult>) {
    edits.sort_by(compare_rename_edits);
    edits.dedup_by(|right, left| same_rename_edit(left, right));
}

/// Compare rename edits in deterministic source order.
fn compare_rename_edits(
    left: &SidecarTextEditResult,
    right: &SidecarTextEditResult,
) -> std::cmp::Ordering {
    rename_edit_key(left).cmp(&rename_edit_key(right))
}

/// Return the fields that uniquely identify a rename replacement.
fn rename_edit_key(edit: &SidecarTextEditResult) -> (u32, u32, u32, u32, &str) {
    (
        edit.start_line,
        edit.start_character,
        edit.end_line,
        edit.end_character,
        edit.new_text.as_str(),
    )
}

/// Test whether two replacements target the same range with the same text.
fn same_rename_edit(left: &SidecarTextEditResult, right: &SidecarTextEditResult) -> bool {
    rename_edit_key(left) == rename_edit_key(right)
}

/// Canonicalize a path into a stable cross-sidecar merge key.
fn normalized_rename_path(path: &str) -> String {
    let canonical = std::fs::canonicalize(path).map_or_else(
        |_| path.to_string(),
        |value| value.to_string_lossy().into_owned(),
    );
    let normalized = strip_rename_verbatim(&canonical).replace('\\', "/");
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

/// Remove the Windows verbatim prefix while preserving UNC semantics.
fn strip_rename_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
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

/// Portable metadata identity returned by the symbol's owning sidecar.
#[derive(serde::Deserialize)]
struct SidecarRenameIdentityResult {
    /// Whether the source position resolved to a cross-language-visible symbol.
    found: bool,
    /// Simple name of the assembly that owns the symbol.
    assembly_name: String,
    /// Standard .NET XML documentation signature for the symbol.
    xml_doc_sig: String,
}

/// Request for references to a metadata symbol owned by the other sidecar.
#[derive(serde::Serialize)]
struct SidecarForeignRenameRequest {
    /// Simple name of the symbol's owning assembly.
    assembly_name: String,
    /// Standard .NET XML documentation signature for the symbol.
    xml_doc_sig: String,
    /// Replacement identifier requested by the editor.
    new_name: String,
}

impl SidecarForeignRenameRequest {
    /// Build the fallback request from the primary sidecar's identity.
    fn new(identity: SidecarRenameIdentityResult, new_name: String) -> Self {
        Self {
            assembly_name: identity.assembly_name,
            xml_doc_sig: identity.xml_doc_sig,
            new_name,
        }
    }
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
#[derive(serde::Deserialize, Clone)]
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
#[derive(serde::Deserialize, Clone)]
struct SidecarDocumentEditResult {
    /// Absolute path to the file.
    file_path: String,
    /// Text edits to apply.
    edits: Vec<SidecarTextEditResult>,
}

/// A workspace-wide set of edits from the sidecar rename operation.
#[derive(serde::Deserialize, Clone)]
struct SidecarWorkspaceEditResult {
    /// Per-document edits.
    document_changes: Vec<SidecarDocumentEditResult>,
}

#[cfg(test)]
mod rename_merge_tests {
    use super::*;

    #[test]
    fn cross_language_merge_normalizes_paths_and_deduplicates_edits() -> Result<()> {
        let duplicate = rename_edit(1, 3, 15, "Renamed");
        let primary = workspace_edit("folder\\Origin.cs", vec![duplicate]);
        let foreign = SidecarWorkspaceEditResult {
            document_changes: vec![
                document_edit("folder/Origin.cs", vec![rename_edit(1, 3, 15, "Renamed")]),
                document_edit("folder/Foreign.fs", vec![rename_edit(2, 8, 14, "Renamed")]),
            ],
        };
        let merged = merge_workspace_edits(primary, foreign)?;
        assert_merged_documents(&merged)
    }

    #[test]
    fn cross_language_merge_rejects_conflicts_and_accepts_boundaries() -> Result<()> {
        assert_overlap_conflicts()?;
        assert_insertion_conflict();
        assert_invalid_and_adjacent_ranges()
    }

    /// A document whose path cannot be turned into a URI must not sink the whole
    /// rename — the remaining documents still have to reach the editor.
    #[test]
    fn unconvertible_document_path_is_skipped_not_fatal() -> Result<()> {
        let absolute = if cfg!(windows) {
            r"C:\repo\Good.cs"
        } else {
            "/repo/Good.cs"
        };
        let result = SidecarWorkspaceEditResult {
            document_changes: vec![
                document_edit("relative/Bad.cs", vec![rename_edit(0, 0, 3, "New")]),
                document_edit(absolute, vec![rename_edit(1, 0, 3, "New")]),
            ],
        };

        let rendered = workspace_edit_value(result)?.to_string();

        assert!(
            rendered.contains("Good.cs"),
            "the convertible document must survive: {rendered}"
        );
        assert!(
            !rendered.contains("Bad.cs"),
            "the unconvertible document must be skipped: {rendered}"
        );
        Ok(())
    }

    fn assert_overlap_conflicts() -> Result<()> {
        let Err(overlap) = merge_workspace_edits(
            workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
            workspace_edit("Origin.cs", vec![rename_edit(1, 8, 18, "Two")]),
        ) else {
            anyhow::bail!("overlapping edits must fail");
        };
        assert!(overlap.to_string().contains("overlapping rename edits"));
        assert!(overlap.to_string().contains("Origin.cs"));
        let conflict = merge_workspace_edits(
            workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
            workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "Two")]),
        );
        assert!(
            conflict.is_err(),
            "same range with different text must fail"
        );
        Ok(())
    }

    fn assert_insertion_conflict() {
        let insertion = merge_workspace_edits(
            workspace_edit("Origin.cs", vec![rename_edit(1, 3, 15, "One")]),
            workspace_edit("Origin.cs", vec![rename_edit(1, 8, 8, "Two")]),
        );
        assert!(insertion.is_err(), "an insertion inside a range must fail");
    }

    #[test]
    fn cross_language_wire_contract_uses_the_declared_key_order() -> Result<()> {
        let bytes = rmp_serde::to_vec(&(true, "Assembly", "T:Example.Symbol"))?;
        let identity: SidecarRenameIdentityResult = rmp_serde::from_slice(&bytes)?;
        assert!(identity.found);
        assert_eq!(identity.assembly_name, "Assembly");
        assert_eq!(identity.xml_doc_sig, "T:Example.Symbol");
        let request = SidecarForeignRenameRequest::new(identity, "Renamed".to_string());
        let bytes = rmp_serde::to_vec(&request)?;
        let tuple: (String, String, String) = rmp_serde::from_slice(&bytes)?;
        assert_eq!(
            tuple,
            (
                "Assembly".into(),
                "T:Example.Symbol".into(),
                "Renamed".into()
            )
        );
        Ok(())
    }

    fn workspace_edit(path: &str, edits: Vec<SidecarTextEditResult>) -> SidecarWorkspaceEditResult {
        SidecarWorkspaceEditResult {
            document_changes: vec![document_edit(path, edits)],
        }
    }

    fn document_edit(path: &str, edits: Vec<SidecarTextEditResult>) -> SidecarDocumentEditResult {
        SidecarDocumentEditResult {
            file_path: path.to_string(),
            edits,
        }
    }

    fn rename_edit(line: u32, start: u32, end: u32, new_text: &str) -> SidecarTextEditResult {
        SidecarTextEditResult {
            start_line: line,
            start_character: start,
            end_line: line,
            end_character: end,
            new_text: new_text.to_string(),
        }
    }

    fn assert_invalid_and_adjacent_ranges() -> Result<()> {
        let invalid = workspace_edit("Origin.cs", vec![rename_edit(2, 9, 4, "Invalid")]);
        let Err(invalid) = canonicalize_workspace_edit(invalid) else {
            anyhow::bail!("reversed ranges must fail");
        };
        assert!(invalid.to_string().contains("invalid rename range"));
        let adjacent = merge_workspace_edits(
            workspace_edit("Origin.cs", vec![rename_edit(1, 3, 8, "One")]),
            workspace_edit("Origin.cs", vec![rename_edit(1, 8, 15, "Two")]),
        )?;
        assert_adjacent_edits(&adjacent)
    }

    fn assert_merged_documents(merged: &SidecarWorkspaceEditResult) -> Result<()> {
        let [foreign, origin] = merged.document_changes.as_slice() else {
            anyhow::bail!("merge must return the two language documents");
        };
        let [origin_edit] = origin.edits.as_slice() else {
            anyhow::bail!("the deduplicated origin must contain one edit");
        };
        assert_eq!(foreign.file_path, "folder/Foreign.fs");
        assert_eq!(foreign.edits.len(), 1);
        assert_eq!(origin_edit.start_character, 3);
        assert_eq!(origin_edit.end_character, 15);
        assert_eq!(origin_edit.new_text, "Renamed");
        Ok(())
    }

    fn assert_adjacent_edits(adjacent: &SidecarWorkspaceEditResult) -> Result<()> {
        let [document] = adjacent.document_changes.as_slice() else {
            anyhow::bail!("adjacent edits must remain in one document");
        };
        let [first, second] = document.edits.as_slice() else {
            anyhow::bail!("both adjacent edits must be preserved");
        };
        assert_eq!(first.new_text, "One");
        assert_eq!(second.new_text, "Two");
        Ok(())
    }
}
