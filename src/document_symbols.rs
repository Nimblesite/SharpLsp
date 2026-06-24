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

    // A sidecar/parse failure yields an empty outline rather than a hard error —
    // a transient outline gap is preferable to a failed request. [FS-DOCSYMBOL]
    let items = match fetch_fsharp_document_symbols(runtime, sidecar, file_path) {
        Ok(items) => items,
        Err(err) => {
            warn!("Sidecar documentSymbol unavailable: {err:#}");
            return Ok(serde_json::to_value(DocumentSymbolResponse::Nested(
                vec![],
            ))?);
        }
    };
    let symbols: Vec<DocumentSymbol> = items.iter().map(map_symbol).collect();
    Ok(serde_json::to_value(DocumentSymbolResponse::Nested(
        symbols,
    ))?)
}

/// Fetch the FCS document-symbol tree for an F# file from the sidecar.
///
/// Shared by the `textDocument/documentSymbol` outline and the Solution
/// Explorer's `sharplsp/workspaceSymbols` tree, so F# files contribute the same
/// FCS-sourced symbols in both — the host has no F# tree-sitter grammar.
/// [FS-DOCSYMBOL]
pub(crate) fn fetch_fsharp_document_symbols(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    file_path: String,
) -> Result<Vec<SidecarDocumentSymbol>> {
    let request = SidecarFileReq { file_path };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        runtime.block_on(sidecar.request("textDocument/documentSymbol", payload))?;
    Ok(rmp_serde::from_slice(&response_bytes)?)
}

/// The full source range of a sidecar symbol.
fn full_range(item: &SidecarDocumentSymbol) -> Range {
    Range::new(
        lsp_types::Position::new(item.start_line, item.start_character),
        lsp_types::Position::new(item.end_line, item.end_character),
    )
}

/// The selection (identifier) range of a sidecar symbol.
fn selection_range(item: &SidecarDocumentSymbol) -> Range {
    Range::new(
        lsp_types::Position::new(item.selection_start_line, item.selection_start_character),
        lsp_types::Position::new(item.selection_end_line, item.selection_end_character),
    )
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
        range: full_range(item),
        selection_range: selection_range(item),
        children: Some(item.children.iter().map(map_symbol).collect()),
    }
}

/// Flatten the F# document-symbol tree for one file into LSP workspace
/// [`SymbolInformation`]s (one entry per symbol, nested members included) so the
/// editor's `workspace/symbol` (Go to Symbol in Workspace / Ctrl-T) search reaches
/// F# symbols. The host has no F# tree-sitter grammar, so — like the outline and
/// the Solution Explorer — these come from the FCS sidecar. Unfiltered; the caller
/// applies the query match. [FS-WORKSPACE-SYMBOL]
pub(crate) fn fsharp_workspace_symbols(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    uri: &lsp_types::Uri,
    file_path: String,
) -> Result<Vec<lsp_types::SymbolInformation>> {
    let items = fetch_fsharp_document_symbols(runtime, sidecar, file_path)?;
    let mut out = Vec::new();
    for item in &items {
        flatten_workspace_symbol(uri, item, None, &mut out);
    }
    Ok(out)
}

/// Recursively flatten a symbol and its children into `SymbolInformation`s,
/// threading each symbol's name down as its children's `container_name`.
fn flatten_workspace_symbol(
    uri: &lsp_types::Uri,
    item: &SidecarDocumentSymbol,
    container: Option<&str>,
    out: &mut Vec<lsp_types::SymbolInformation>,
) {
    #[expect(
        deprecated,
        reason = "SymbolInformation is the LSP 3.17 workspace/symbol response type"
    )]
    out.push(lsp_types::SymbolInformation {
        name: item.name.clone(),
        kind: parse_document_symbol_kind(&item.kind),
        tags: None,
        deprecated: None,
        location: lsp_types::Location {
            uri: uri.clone(),
            range: full_range(item),
        },
        container_name: container.map(str::to_string),
    });
    for child in &item.children {
        flatten_workspace_symbol(uri, child, Some(&item.name), out);
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
/// `pub(crate)` so the Solution Explorer (`workspace_symbols`) can map the same
/// FCS symbols into its tree model. [FS-DOCSYMBOL]
#[derive(serde::Deserialize)]
pub(crate) struct SidecarDocumentSymbol {
    /// Display name of the symbol.
    pub(crate) name: String,
    /// Symbol kind string (e.g. "Module", "Class", "Function").
    pub(crate) kind: String,
    /// Start line of the full symbol range.
    pub(crate) start_line: u32,
    /// Start character of the full symbol range.
    pub(crate) start_character: u32,
    /// End line of the full symbol range.
    pub(crate) end_line: u32,
    /// End character of the full symbol range.
    pub(crate) end_character: u32,
    /// Start line of the selection (identifier) range.
    pub(crate) selection_start_line: u32,
    /// Start character of the selection (identifier) range.
    pub(crate) selection_start_character: u32,
    /// End line of the selection (identifier) range.
    pub(crate) selection_end_line: u32,
    /// End character of the selection (identifier) range.
    pub(crate) selection_end_character: u32,
    /// Nested child symbols (members of a module, type, etc.).
    pub(crate) children: Vec<SidecarDocumentSymbol>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
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
    fn flatten_workspace_symbol_flattens_tree_with_containers() {
        // Geometry (Module) → { area (Function), Greeter (Class) → Greet (Method) }
        let mut module = leaf("Geometry", "Module");
        let mut greeter = leaf("Greeter", "Class");
        // The F# sidecar maps member glyphs to "Function" (see FSharpSymbols.fs).
        greeter.children = vec![leaf("Greet", "Function")];
        module.children = vec![leaf("area", "Function"), greeter];

        let uri: lsp_types::Uri = "file:///tmp/Library.fs".parse().unwrap();
        let mut out = Vec::new();
        flatten_workspace_symbol(&uri, &module, None, &mut out);

        // Four symbols: the module plus its two members plus the nested method.
        assert_eq!(out.len(), 4);
        let names: Vec<&str> = out.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["Geometry", "area", "Greeter", "Greet"]);

        // Top-level module has no container; members are contained by their parent.
        assert_eq!(out[0].container_name, None);
        assert_eq!(out[1].container_name.as_deref(), Some("Geometry"));
        assert_eq!(out[2].container_name.as_deref(), Some("Geometry"));
        assert_eq!(out[3].container_name.as_deref(), Some("Greeter"));
        assert_eq!(out[0].kind, SymbolKind::MODULE);
        assert_eq!(out[3].kind, SymbolKind::FUNCTION);
        // Every symbol points back at the requested document.
        assert!(out.iter().all(|s| s.location.uri == uri));
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
