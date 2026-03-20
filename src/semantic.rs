//! Semantic request handlers routed through the .NET sidecar.
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionParams, CompletionResponse,
    GotoDefinitionParams, GotoDefinitionResponse, Hover, HoverContents, HoverParams, Location,
    MarkupContent, MarkupKind, Position, Range, Uri,
};


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
    let response_bytes = runtime.block_on(
        sidecar.request("textDocument/completion", payload),
    )?;

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
        return Ok(serde_json::Value::Null);
    };
    let params: HoverParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(
        &params.text_document_position_params.text_document.uri,
    )?;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = runtime.block_on(
        sidecar.request("textDocument/hover", payload),
    )?;

    let result: Option<SidecarHoverResult> = rmp_serde::from_slice(&response_bytes)?;
    let hover = result.map(|r| Hover {
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("```csharp\n{}\n```", r.contents),
        }),
        range: None,
    });

    Ok(serde_json::to_value(hover)?)
}

/// Handle `textDocument/definition` via the C# sidecar.
pub fn handle_definition(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: GotoDefinitionParams = serde_json::from_value(req.params)?;
    let file_path = uri_to_path(
        &params.text_document_position_params.text_document.uri,
    )?;
    let line = params.text_document_position_params.position.line;
    let character = params.text_document_position_params.position.character;

    let request = SidecarPositionReq {
        file_path,
        line,
        character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes = runtime.block_on(
        sidecar.request("textDocument/definition", payload),
    )?;

    let result: Option<SidecarLocationResult> =
        rmp_serde::from_slice(&response_bytes)?;

    let response = result.and_then(|loc| {
        let path = format!("file://{}", loc.file_path);
        let uri: Uri = path.parse().ok()?;
        Some(GotoDefinitionResponse::Scalar(Location {
            uri,
            range: Range::new(
                Position::new(loc.line, loc.character),
                Position::new(loc.line, loc.character),
            ),
        }))
    });

    Ok(serde_json::to_value(response)?)
}

/// Convert a file URI to a filesystem path string.
fn uri_to_path(uri: &Uri) -> Result<String> {
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

#[derive(serde::Deserialize)]
struct SidecarHoverResult {
    contents: String,
}

#[derive(serde::Deserialize)]
struct SidecarLocationResult {
    file_path: String,
    line: u32,
    character: u32,
}
