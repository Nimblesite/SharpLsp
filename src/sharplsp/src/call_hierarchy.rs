//! Call hierarchy handlers (`textDocument/prepareCallHierarchy`,
//! `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`).

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem,
    CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams,
    Position, Range, SymbolKind,
};
use tracing::debug;

use crate::hierarchy::{
    hierarchy_item_location, prepare_hierarchy, SidecarCallHierarchyCall, SidecarHierarchyItem,
};
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarPositionReq};

/// Handle `textDocument/prepareCallHierarchy`.
pub fn handle_prepare(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: CallHierarchyPrepareParams| {
            prepare_hierarchy(
                runtime,
                sidecar,
                "textDocument/prepareCallHierarchy",
                &params.text_document_position_params,
                map_hierarchy_item,
            )
        },
    )
}

/// Handle `callHierarchy/incomingCalls`.
pub fn handle_incoming(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: CallHierarchyIncomingCallsParams| {
            hierarchy_calls(
                runtime,
                sidecar,
                "callHierarchy/incomingCalls",
                &params.item,
                |from, from_ranges| CallHierarchyIncomingCall { from, from_ranges },
            )
        },
    )
}

/// Handle `callHierarchy/outgoingCalls`.
pub fn handle_outgoing(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: CallHierarchyOutgoingCallsParams| {
            hierarchy_calls(
                runtime,
                sidecar,
                "callHierarchy/outgoingCalls",
                &params.item,
                |to, from_ranges| CallHierarchyOutgoingCall { to, from_ranges },
            )
        },
    )
}

/// The calls the sidecar reports for `item` via `method`, each built by `make`.
///
/// An unreachable sidecar answers an empty list, the same as a symbol with no
/// callers: the tree shows nothing rather than an error.
fn hierarchy_calls<T: serde::Serialize>(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    method: &str,
    item: &CallHierarchyItem,
    make: impl Fn(CallHierarchyItem, Vec<Range>) -> T,
) -> Result<serde_json::Value> {
    let request = SidecarPositionReq::at(&item.uri, item.selection_range.start)?;
    let calls: Vec<SidecarCallHierarchyCall> =
        request_sidecar(runtime, sidecar, method, &request)?.unwrap_or_default();
    debug!(method, count = calls.len(), "hierarchy calls from sidecar");
    let result: Vec<T> = calls
        .iter()
        .filter_map(|call| {
            Some(make(
                map_hierarchy_item(&call.item())?,
                call_site_ranges(call),
            ))
        })
        .collect();
    Ok(serde_json::to_value(result)?)
}

/// The ranges at which the calls appear, per LSP 3.17.
///
/// A sidecar that reported no site still yields one range - the declaration -
/// so an engine that cannot supply them degrades to naming the symbol rather
/// than dropping the caller out of the tree entirely.
fn call_site_ranges(call: &SidecarCallHierarchyCall) -> Vec<Range> {
    if call.from_ranges.is_empty() {
        return vec![Range::new(
            Position::new(call.line, call.character),
            Position::new(call.end_line, call.end_character),
        )];
    }
    call.from_ranges
        .iter()
        .map(|site| {
            Range::new(
                Position::new(site.line, site.character),
                Position::new(site.end_line, site.end_character),
            )
        })
        .collect()
}

// ── Helpers ────────────────────────────────────────────────────────

/// Convert a sidecar hierarchy item into an LSP `CallHierarchyItem`.
fn map_hierarchy_item(item: &SidecarHierarchyItem) -> Option<CallHierarchyItem> {
    let (uri, range, selection_range) = hierarchy_item_location(item)?;
    Some(CallHierarchyItem {
        name: item.name.clone(),
        kind: parse_symbol_kind(&item.kind),
        tags: None,
        detail: None,
        uri,
        range,
        selection_range,
        data: None,
    })
}

/// Parse a sidecar symbol kind string into an LSP `SymbolKind`.
fn parse_symbol_kind(kind: &str) -> SymbolKind {
    match kind {
        "Function" => SymbolKind::FUNCTION,
        "Constructor" => SymbolKind::CONSTRUCTOR,
        "Property" => SymbolKind::PROPERTY,
        "Field" => SymbolKind::FIELD,
        "Class" => SymbolKind::CLASS,
        "Interface" => SymbolKind::INTERFACE,
        "Struct" => SymbolKind::STRUCT,
        "Enum" => SymbolKind::ENUM,
        "Module" | "Namespace" => SymbolKind::MODULE,
        _ => SymbolKind::METHOD,
    }
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    fn item(name: &str, kind: &str, path: &str) -> SidecarHierarchyItem {
        SidecarHierarchyItem {
            name: name.to_string(),
            kind: kind.to_string(),
            file_path: path.to_string(),
            line: 10,
            character: 4,
            end_line: 10,
            end_character: 14,
        }
    }

    #[test]
    fn parse_symbol_kind_known_kinds() {
        assert_eq!(parse_symbol_kind("Function"), SymbolKind::FUNCTION);
        assert_eq!(parse_symbol_kind("Constructor"), SymbolKind::CONSTRUCTOR);
        assert_eq!(parse_symbol_kind("Property"), SymbolKind::PROPERTY);
        assert_eq!(parse_symbol_kind("Field"), SymbolKind::FIELD);
        assert_eq!(parse_symbol_kind("Class"), SymbolKind::CLASS);
        assert_eq!(parse_symbol_kind("Interface"), SymbolKind::INTERFACE);
        assert_eq!(parse_symbol_kind("Struct"), SymbolKind::STRUCT);
        assert_eq!(parse_symbol_kind("Enum"), SymbolKind::ENUM);
        assert_eq!(parse_symbol_kind("Module"), SymbolKind::MODULE);
        assert_eq!(parse_symbol_kind("Namespace"), SymbolKind::MODULE);
    }

    #[test]
    fn parse_symbol_kind_unknown_falls_back_to_method() {
        assert_eq!(parse_symbol_kind(""), SymbolKind::METHOD);
        assert_eq!(parse_symbol_kind("Whatever"), SymbolKind::METHOD);
    }

    #[test]
    fn map_hierarchy_item_translates_fields() {
        use crate::paths::test_paths::{NATIVE_FILE, NATIVE_FILE_URI};
        let sidecar = item("Foo", "Class", NATIVE_FILE);
        let mapped = map_hierarchy_item(&sidecar).unwrap();
        assert_eq!(mapped.name, "Foo");
        assert_eq!(mapped.kind, SymbolKind::CLASS);
        assert_eq!(mapped.uri.as_str(), NATIVE_FILE_URI);
        assert_eq!(mapped.range.start, Position::new(10, 4));
        assert_eq!(mapped.range.end, Position::new(10, 14));
        // The sidecar's span IS the identifier, so the selection covers it in
        // full rather than collapsing to a caret at its start.
        assert_eq!(mapped.selection_range, mapped.range);
        assert_eq!(mapped.selection_range.end, Position::new(10, 14));
    }

    #[test]
    fn map_hierarchy_item_returns_none_for_unparseable_path() {
        let bad = item("Foo", "Class", "\u{0}");
        assert!(map_hierarchy_item(&bad).is_none());
    }
}
