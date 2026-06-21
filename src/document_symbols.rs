//! F# document symbols (`textDocument/documentSymbol`).
//!
//! C# document symbols are answered syntactically by tree-sitter in
//! [`crate::handlers::handle_document_symbols`]. F# has no tree-sitter grammar
//! in the host, so F# symbols are sourced from the sidecar's FCS navigation
//! items and mapped here into nested LSP [`DocumentSymbol`]s. Implements
//! [FS-DOCSYMBOL].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{DocumentSymbol, DocumentSymbolParams, DocumentSymbolResponse, Range, SymbolKind};
use tracing::warn;

use crate::sidecar::manager::SidecarManager;
use crate::utils::SidecarFileReq;

/// Handle `textDocument/documentSymbol` for an F# file via the sidecar.
pub fn handle_fsharp(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    // F# has no host tree-sitter grammar; symbols are only available when the
    // FCS sidecar is running. With no sidecar (F# disabled / no workspace root)
    // the request cannot be served — surface that as an error rather than a
    // misleading empty outline. [FS-DOCSYMBOL]
    let Some(sidecar) = sidecar else {
        anyhow::bail!("F# sidecar unavailable; cannot compute document symbols");
    };
    let params: DocumentSymbolParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarFileReq { file_path };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/documentSymbol", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar documentSymbol unavailable: {err:#}");
                return Ok(serde_json::to_value(DocumentSymbolResponse::Nested(
                    vec![],
                ))?);
            }
        };

    let items: Vec<SidecarDocumentSymbol> = rmp_serde::from_slice(&response_bytes)?;
    let symbols: Vec<DocumentSymbol> = items.iter().map(map_symbol).collect();
    Ok(serde_json::to_value(DocumentSymbolResponse::Nested(
        symbols,
    ))?)
}

/// Convert a sidecar document symbol (and its children) into an LSP one.
fn map_symbol(item: &SidecarDocumentSymbol) -> DocumentSymbol {
    #[expect(
        deprecated,
        reason = "DocumentSymbol::deprecated is a required struct field"
    )]
    DocumentSymbol {
        name: item.name.clone(),
        detail: None,
        kind: parse_document_symbol_kind(&item.kind),
        tags: None,
        deprecated: None,
        range: Range::new(
            lsp_types::Position::new(item.start_line, item.start_character),
            lsp_types::Position::new(item.end_line, item.end_character),
        ),
        selection_range: Range::new(
            lsp_types::Position::new(item.selection_start_line, item.selection_start_character),
            lsp_types::Position::new(item.selection_end_line, item.selection_end_character),
        ),
        children: Some(item.children.iter().map(map_symbol).collect()),
    }
}

/// Parse a sidecar symbol-kind string into an LSP [`SymbolKind`].
fn parse_document_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "Module" => SymbolKind::MODULE,
        "Namespace" => SymbolKind::NAMESPACE,
        "Class" => SymbolKind::CLASS,
        "Interface" => SymbolKind::INTERFACE,
        "Struct" => SymbolKind::STRUCT,
        "Enum" => SymbolKind::ENUM,
        "EnumMember" => SymbolKind::ENUM_MEMBER,
        "Constructor" => SymbolKind::CONSTRUCTOR,
        "Function" => SymbolKind::FUNCTION,
        "Property" => SymbolKind::PROPERTY,
        "Constant" => SymbolKind::CONSTANT,
        "Variable" => SymbolKind::VARIABLE,
        "TypeParameter" => SymbolKind::TYPE_PARAMETER,
        _ => SymbolKind::FIELD,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// A nested document symbol returned by the sidecar. Deserialized from a
/// positional `MessagePack` array matching the sidecar's `DocumentSymbolResult`.
#[derive(serde::Deserialize)]
struct SidecarDocumentSymbol {
    /// Display name of the symbol.
    name: String,
    /// Symbol kind string (e.g. "Module", "Class", "Function").
    kind: String,
    /// Start line of the full symbol range.
    start_line: u32,
    /// Start character of the full symbol range.
    start_character: u32,
    /// End line of the full symbol range.
    end_line: u32,
    /// End character of the full symbol range.
    end_character: u32,
    /// Start line of the selection (identifier) range.
    selection_start_line: u32,
    /// Start character of the selection (identifier) range.
    selection_start_character: u32,
    /// End line of the selection (identifier) range.
    selection_end_line: u32,
    /// End character of the selection (identifier) range.
    selection_end_character: u32,
    /// Nested child symbols (members of a module, type, etc.).
    children: Vec<SidecarDocumentSymbol>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    fn leaf(name: &str, kind: &str) -> SidecarDocumentSymbol {
        SidecarDocumentSymbol {
            name: name.to_string(),
            kind: kind.to_string(),
            start_line: 1,
            start_character: 0,
            end_line: 3,
            end_character: 5,
            selection_start_line: 1,
            selection_start_character: 2,
            selection_end_line: 1,
            selection_end_character: 8,
            children: vec![],
        }
    }

    #[test]
    fn parse_document_symbol_kind_known_kinds() {
        assert_eq!(parse_document_symbol_kind("Module"), SymbolKind::MODULE);
        assert_eq!(
            parse_document_symbol_kind("Namespace"),
            SymbolKind::NAMESPACE
        );
        assert_eq!(parse_document_symbol_kind("Class"), SymbolKind::CLASS);
        assert_eq!(
            parse_document_symbol_kind("Interface"),
            SymbolKind::INTERFACE
        );
        assert_eq!(parse_document_symbol_kind("Function"), SymbolKind::FUNCTION);
        assert_eq!(parse_document_symbol_kind("Property"), SymbolKind::PROPERTY);
        assert_eq!(parse_document_symbol_kind("Field"), SymbolKind::FIELD);
    }

    #[test]
    fn parse_document_symbol_kind_unknown_falls_back_to_field() {
        assert_eq!(parse_document_symbol_kind("Whatever"), SymbolKind::FIELD);
    }

    #[test]
    fn map_symbol_maps_fields_and_nested_children() {
        let mut module = leaf("Geometry", "Module");
        module.children = vec![leaf("area", "Function")];
        let mapped = map_symbol(&module);
        assert_eq!(mapped.name, "Geometry");
        assert_eq!(mapped.kind, SymbolKind::MODULE);
        assert_eq!(mapped.range.start, lsp_types::Position::new(1, 0));
        assert_eq!(mapped.range.end, lsp_types::Position::new(3, 5));
        assert_eq!(mapped.selection_range.start, lsp_types::Position::new(1, 2));
        let children = mapped.children.unwrap();
        assert_eq!(children.len(), 1);
        let first = children.first().unwrap();
        assert_eq!(first.name, "area");
        assert_eq!(first.kind, SymbolKind::FUNCTION);
    }

    #[test]
    fn handle_fsharp_without_sidecar_errors() {
        let req = Request {
            id: lsp_server::RequestId::from(1),
            method: "textDocument/documentSymbol".to_string(),
            params: serde_json::Value::Null,
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        // No sidecar → F# symbols cannot be computed → error (not empty).
        assert!(handle_fsharp(req, &runtime, None).is_err());
    }
}
