//! Syntax-level LSP request handlers and tree-sitter pre-validation.
//!
//! These handlers are dispatched from the main loop for requests that
//! can be answered entirely in Rust (no sidecar round-trip).

use std::collections::HashMap;

use anyhow::{Context, Result};
use lsp_server::Request;
use lsp_types::{
    DocumentSymbolParams, DocumentSymbolResponse, FoldingRangeParams, GotoDefinitionParams,
    HoverParams, LinkedEditingRangeParams, SelectionRangeParams, Uri,
};
use tree_sitter::Tree;

use crate::syntax;
use crate::tree_sitter_parse::{LangId, TsParsers};
use crate::vfs::Vfs;

// ── Syntax-only request handlers ─────────────────────────────────

/// Handle `textDocument/documentSymbol` using tree-sitter.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn handle_document_symbols(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: DocumentSymbolParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;
    let source = vfs.get_content(uri).context("document not found in VFS")?;
    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let symbols = syntax::document_symbols(&tree, &source);
    let response = DocumentSymbolResponse::Nested(symbols);
    Ok(serde_json::to_value(response)?)
}

/// Handle `textDocument/foldingRange` using tree-sitter.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn handle_folding_ranges(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: FoldingRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;
    let source = vfs.get_content(uri).context("document not found in VFS")?;
    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let ranges = syntax::folding_ranges(&tree, &source);
    Ok(serde_json::to_value(ranges)?)
}

/// Handle `textDocument/selectionRange` using tree-sitter.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn handle_selection_ranges(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: SelectionRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document.uri;
    let source = vfs.get_content(uri).context("document not found in VFS")?;
    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let ranges = syntax::selection_ranges(&tree, &source, &params.positions);
    Ok(serde_json::to_value(ranges)?)
}

/// Handle `textDocument/linkedEditingRange` using tree-sitter.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn handle_linked_editing_range(
    req: Request,
    vfs: &Vfs,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<serde_json::Value> {
    let params: LinkedEditingRangeParams = serde_json::from_value(req.params)?;
    let uri = &params.text_document_position_params.text_document.uri;
    let source = vfs.get_content(uri).context("document not found in VFS")?;
    let tree = get_or_parse_tree(uri, &source, parsers, trees)?;
    let position = params.text_document_position_params.position;
    let result = syntax::linked_editing_ranges(&tree, &source, position);
    Ok(serde_json::to_value(result)?)
}

// ── Tree-sitter pre-validation ───────────────────────────────────

/// Return `true` if hover position is a comment.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn is_hover_on_comment(req: &Request, trees: &HashMap<Uri, Tree>) -> bool {
    extract_position::<HoverParams>(req)
        .and_then(|(uri, pos)| trees.get(&uri).map(|tree| (tree, pos)))
        .is_some_and(|(tree, pos)| syntax::is_comment_at_position(tree, pos))
}

/// Return `true` if position is a comment or string literal.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
pub fn is_non_symbol_position(req: &Request, trees: &HashMap<Uri, Tree>) -> bool {
    extract_position::<GotoDefinitionParams>(req)
        .and_then(|(uri, pos)| trees.get(&uri).map(|tree| (tree, pos)))
        .is_some_and(|(tree, pos)| {
            syntax::is_comment_at_position(tree, pos) || syntax::is_string_at_position(tree, pos)
        })
}

// ── Helpers ──────────────────────────────────────────────────────

/// Get a cached tree or parse fresh.
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn get_or_parse_tree(
    uri: &Uri,
    source: &str,
    parsers: &TsParsers,
    trees: &HashMap<Uri, Tree>,
) -> Result<Tree> {
    let lang = LangId::from_uri(uri).context("unsupported file type")?;
    let old_tree = trees.get(uri);
    parsers.parse(lang, source, old_tree)
}

/// Extract `(uri, position)` from any params with `text_document_position_params`.
fn extract_position<T: serde::de::DeserializeOwned + HasTextDocumentPosition>(
    req: &Request,
) -> Option<(Uri, lsp_types::Position)> {
    let params: T = serde_json::from_value(req.params.clone()).ok()?;
    let (uri, position) = params.text_document_position();
    Some((uri, position))
}

/// Trait for extracting text document position from LSP params.
trait HasTextDocumentPosition {
    /// Return the document URI and cursor position from the LSP params.
    fn text_document_position(&self) -> (Uri, lsp_types::Position);
}

impl HasTextDocumentPosition for HoverParams {
    /// Extract the URI and cursor position from hover params.
    fn text_document_position(&self) -> (Uri, lsp_types::Position) {
        (
            self.text_document_position_params.text_document.uri.clone(),
            self.text_document_position_params.position,
        )
    }
}

impl HasTextDocumentPosition for GotoDefinitionParams {
    /// Extract the URI and cursor position from goto-definition params.
    fn text_document_position(&self) -> (Uri, lsp_types::Position) {
        (
            self.text_document_position_params.text_document.uri.clone(),
            self.text_document_position_params.position,
        )
    }
}
