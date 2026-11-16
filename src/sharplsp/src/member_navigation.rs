//! `sharplsp/adjacentMember` — structural navigation: where the next or the
//! previous member of the document starts. Members are the document's symbols
//! (the outline's), namespaces aside, so the answer is the same tree the
//! breadcrumbs read: tree-sitter for C#, the F# compiler's for F#, the Razor
//! compiler's for Razor.
//! [SHARPLSP-FEATURES-NAVIGATION-MEMBERS]

use std::sync::Arc;

use anyhow::{Context, Result};
use lsp_server::Request;
use lsp_types::{DocumentSymbol, Position, SymbolKind, TextDocumentIdentifier};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::runtime::Runtime;
use tracing::info;

use crate::document_symbols;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::{parse_file, LangId, TsParsers};
use crate::vfs::Vfs;

/// Which neighbour is wanted.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Direction {
    /// The first member that starts after the position.
    Next,
    /// The last member that starts before the position.
    Previous,
}

/// Request params for `sharplsp/adjacentMember`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdjacentMemberParams {
    /// The document being navigated.
    text_document: TextDocumentIdentifier,
    /// The caret.
    position: Position,
    /// Which way to go.
    direction: Direction,
}

/// Response for `sharplsp/adjacentMember`.
#[derive(Debug, Serialize)]
struct AdjacentMemberResponse {
    /// Where the neighbour's name starts; `None` past the last or first member.
    position: Option<Position>,
}

/// Handle `sharplsp/adjacentMember`; `engines` are the C# and F# sidecars.
pub fn handle(
    req: Request,
    parsers: &TsParsers,
    vfs: &Vfs,
    runtime: &Runtime,
    engines: [Option<&Arc<SidecarManager>>; 2],
) -> Result<Value> {
    let params: AdjacentMemberParams = serde_json::from_value(req.params)?;
    let path = crate::paths::uri_to_path(params.text_document.uri.as_str())?;
    let symbols = match LangId::from_uri(&params.text_document.uri) {
        Some(LangId::CSharp) => syntax_symbols(&path, parsers, vfs)?,
        Some(LangId::Razor) => sidecar_symbols(runtime, engines[0], path)?,
        Some(LangId::FSharp) => sidecar_symbols(runtime, engines[1], path)?,
        None => anyhow::bail!("unsupported file type"),
    };
    let mut starts = Vec::new();
    collect_starts(&symbols, &mut starts);
    starts.sort_unstable();
    let position = adjacent(&starts, params.position, params.direction);
    info!(method = "sharplsp/adjacentMember", uri = %params.text_document.uri.as_str(), members = starts.len(), found = position.is_some(), "adjacent member resolved");
    Ok(serde_json::to_value(AdjacentMemberResponse { position })?)
}

/// A C# document's symbols, from its concrete syntax tree.
fn syntax_symbols(path: &str, parsers: &TsParsers, vfs: &Vfs) -> Result<Vec<DocumentSymbol>> {
    let (source, tree) = parse_file(path, parsers, vfs)?;
    Ok(crate::syntax::document_symbols(&tree, &source))
}

/// An F# or Razor document's symbols, from the sidecar that outlines it.
fn sidecar_symbols(
    runtime: &Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    path: String,
) -> Result<Vec<DocumentSymbol>> {
    let sidecar = sidecar.context("the language service for this file is not running")?;
    document_symbols::sidecar_symbols(runtime, sidecar, path)
}

/// Where every member's own name starts, namespaces aside, at any depth.
fn collect_starts(symbols: &[DocumentSymbol], starts: &mut Vec<Position>) {
    for symbol in symbols {
        if symbol.kind != SymbolKind::NAMESPACE {
            starts.push(symbol.selection_range.start);
        }
        collect_starts(symbol.children.as_deref().unwrap_or_default(), starts);
    }
}

/// The neighbour of `at` among the sorted `starts`.
fn adjacent(starts: &[Position], at: Position, direction: Direction) -> Option<Position> {
    match direction {
        Direction::Next => starts.iter().copied().find(|start| *start > at),
        Direction::Previous => starts.iter().rev().copied().find(|start| *start < at),
    }
}
