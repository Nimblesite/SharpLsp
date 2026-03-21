//! Semantic request handlers routed through the .NET sidecar.
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionParams, CompletionResponse, GotoDefinitionParams,
    GotoDefinitionResponse, Hover, HoverContents, HoverParams, Location, MarkupContent, MarkupKind,
    Position, Range, Uri,
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

/// Handle `textDocument/definition` via the C# sidecar.
pub fn handle_definition(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_single_location_nav(req, runtime, sidecar, "textDocument/definition")
}

/// Handle `textDocument/typeDefinition` via the C# sidecar.
pub fn handle_type_definition(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_single_location_nav(req, runtime, sidecar, "textDocument/typeDefinition")
}

/// Handle `textDocument/declaration` via the C# sidecar.
pub fn handle_declaration(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    handle_single_location_nav(req, runtime, sidecar, "textDocument/declaration")
}

/// Handle `textDocument/implementation` via the C# sidecar.
///
/// Returns `Location[]` because a symbol may have multiple implementations.
pub fn handle_implementation(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        debug!("Implementation: no sidecar available");
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
        "Implementation request dispatching to sidecar"
    );

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/implementation", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar implementation unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let result: SidecarLocationListResult = rmp_serde::from_slice(&response_bytes)?;
    let locations: Vec<Location> = result
        .locations
        .into_iter()
        .filter_map(|loc| sidecar_location_to_lsp(&loc))
        .collect();

    let response = GotoDefinitionResponse::Array(locations);
    Ok(serde_json::to_value(response)?)
}

// ── Shared Helpers ────────────────────────────────────────────────

/// Shared handler for single-location navigation requests
/// (definition, typeDefinition, declaration).
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

    let result: Option<SidecarLocationResult> = rmp_serde::from_slice(&response_bytes)?;
    let response = result.and_then(|loc| {
        let location = sidecar_location_to_lsp(&loc)?;
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
            Position::new(loc.line, loc.character),
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
    let s = uri.as_str();
    s.strip_prefix("file://")
        .map(String::from)
        .context("expected file:// URI")
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
}

#[derive(serde::Deserialize)]
struct SidecarLocationListResult {
    locations: Vec<SidecarLocationResult>,
}
