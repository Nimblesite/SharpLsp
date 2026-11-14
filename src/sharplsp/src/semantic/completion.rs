//! `textDocument/completion` and `completionItem/resolve` through the sidecar,
//! merged with the host's postfix templates. [SHARPLSP-FEATURES-INTELLIGENCE]

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionParams, CompletionResponse, CompletionTextEdit,
    Documentation, MarkupContent, MarkupKind, Uri,
};
use tracing::warn;

use crate::paths::uri_to_path;
use crate::postfix_completion::get_postfix_completions;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::LangId;
use crate::utils::{map_text_edit, map_text_edits, request_sidecar, SidecarTextEdit};
use crate::vfs::Vfs;

/// Handle `textDocument/completion` via the .NET sidecar + postfix templates.
pub fn handle_completion(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    vfs: &Vfs,
) -> Result<serde_json::Value> {
    let params: CompletionParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position.text_document.uri;
    let position = params.text_document_position.position;
    let mut items = postfix_items(vfs, uri, position.line, position.character);
    if let Some(sidecar) = sidecar {
        let request = SidecarCompletionReq {
            file_path: uri_to_path(uri.as_str())?,
            line: position.line,
            character: position.character,
        };
        items.extend(sidecar_items(runtime, sidecar, uri, &request)?);
    }
    if items.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    Ok(serde_json::to_value(CompletionResponse::Array(items))?)
}

/// Postfix template completions computed from the open document's text.
fn postfix_items(vfs: &Vfs, uri: &Uri, line: u32, character: u32) -> Vec<CompletionItem> {
    let Some(source) = vfs.get_content(uri) else {
        return Vec::new();
    };
    LangId::from_uri(uri)
        .map_or_default(|lang| get_postfix_completions(&source, line, character, lang))
}

/// The sidecar's completions for `request`; an unavailable sidecar contributes
/// nothing so the postfix templates still answer.
fn sidecar_items(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    uri: &Uri,
    request: &SidecarCompletionReq,
) -> Result<Vec<CompletionItem>> {
    let payload = rmp_serde::to_vec(request)?;
    let response = match runtime.block_on(sidecar.request("textDocument/completion", payload)) {
        Ok(bytes) => bytes,
        Err(err) => {
            warn!("Sidecar completion unavailable: {err:#}");
            return Ok(Vec::new());
        }
    };
    let items: Vec<SidecarCompletionItem> = rmp_serde::from_slice(&response)?;
    Ok(items
        .into_iter()
        .map(|item| lsp_item(item, uri, &request.file_path))
        .collect())
}

/// Translate one sidecar completion into its LSP item, tagged so resolve
/// returns to the same language. [SHARPLSP-FEATURES-INTELLIGENCE]
fn lsp_item(item: SidecarCompletionItem, uri: &Uri, file_path: &str) -> CompletionItem {
    CompletionItem {
        label: item.label,
        kind: Some(map_completion_kind(&item.kind)),
        detail: item.detail,
        insert_text: item.insert_text,
        // A textEdit makes acceptance REPLACE the identifier span at the caret
        // instead of appending it (GitHub #178).
        // Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
        text_edit: item
            .text_edit
            .as_ref()
            .map(|edit| CompletionTextEdit::Edit(map_text_edit(edit))),
        documentation: item.documentation.map(|value| {
            Documentation::MarkupContent(MarkupContent {
                kind: MarkupKind::Markdown,
                value,
            })
        }),
        sort_text: item.sort_text,
        data: Some(serde_json::json!({
            "uri": uri.as_str(),
            "file_path": file_path,
            "index": item.index,
        })),
        ..CompletionItem::default()
    }
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
    let Some(request) = resolve_request(item.data.as_ref()) else {
        return Ok(serde_json::to_value(item)?);
    };
    let result = request_sidecar::<SidecarCompletionResolveResult, _>(
        runtime,
        sidecar,
        "completionItem/resolve",
        &request,
    )?;
    if let Some(result) = result.filter(|result| !result.additional_edits.is_empty()) {
        item.additional_text_edits = Some(map_text_edits(&result.additional_edits));
    }
    Ok(serde_json::to_value(item)?)
}

/// The resolve request encoded in an item's `data`, when it names a sidecar item.
fn resolve_request(data: Option<&serde_json::Value>) -> Option<SidecarCompletionResolveReq> {
    let data = data?;
    let file_path = data.get("file_path")?.as_str()?;
    let index = i32::try_from(data.get("index")?.as_i64()?).ok()?;
    (!file_path.is_empty() && index >= 0).then(|| SidecarCompletionResolveReq {
        file_path: file_path.to_string(),
        index,
    })
}

/// Map a Roslyn/FCS completion tag to the LSP completion item kind.
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
        "Value" => CompletionItemKind::VALUE,
        _ => CompletionItemKind::TEXT,
    }
}

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
    /// Markdown documentation, when the item has any. [RAZOR-FEATURES-COMPLETION]
    #[serde(default)]
    documentation: Option<String>,
    /// The order an editor sorts the item in, when it is not the label's.
    #[serde(default)]
    sort_text: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_request_requires_a_sidecar_tagged_item() {
        assert!(resolve_request(None).is_none());
        assert!(resolve_request(Some(&serde_json::json!({"index": 3}))).is_none());
        assert!(resolve_request(Some(&serde_json::json!({"file_path": "", "index": 3}))).is_none());
        assert!(resolve_request(Some(
            &serde_json::json!({"file_path": "/a.cs", "index": -1})
        ))
        .is_none());
        let request = resolve_request(Some(&serde_json::json!({"file_path": "/a.cs", "index": 7})));
        assert!(request.is_some_and(|r| r.file_path == "/a.cs" && r.index == 7));
    }

    #[test]
    fn completion_kinds_map_every_roslyn_tag() {
        assert_eq!(
            map_completion_kind("ExtensionMethod"),
            CompletionItemKind::METHOD
        );
        assert_eq!(
            map_completion_kind("RangeVariable"),
            CompletionItemKind::VARIABLE
        );
        assert_eq!(map_completion_kind("Namespace"), CompletionItemKind::MODULE);
        assert_eq!(map_completion_kind("Unknown"), CompletionItemKind::TEXT);
    }
}
