//! What the call- and type-hierarchy handlers share: the sidecar's wire shapes
//! for a hierarchy item and a call, the LSP location they map to, and the
//! `prepare` and follow-up requests both hierarchies answer the same way.

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{Position, Range, TextDocumentPositionParams, Uri};
use tracing::debug;

use crate::paths::path_to_lsp_uri;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarPositionReq};

/// A hierarchy item returned by the sidecar for call- and type-hierarchy
/// requests. Shared by `call_hierarchy` and `type_hierarchy`, which map it
/// into their respective LSP item types.
#[derive(serde::Deserialize)]
pub struct SidecarHierarchyItem {
    /// Display name of the symbol.
    pub name: String,
    /// Symbol kind string (e.g. "Function", "Class").
    pub kind: String,
    /// Absolute path to the file containing this symbol.
    pub file_path: String,
    /// Start line of the symbol range.
    pub line: u32,
    /// Start character offset within the start line.
    pub character: u32,
    /// End line of the symbol range.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
}

/// One range at which a call appears, as the sidecars report it.
#[derive(serde::Deserialize)]
pub struct SidecarCallSite {
    /// Start line of the call site.
    pub line: u32,
    /// Start character offset within the start line.
    pub character: u32,
    /// End line of the call site.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
}

/// A caller or callee, together with every range at which the call appears.
///
/// Distinct from [`SidecarHierarchyItem`] because only the call-hierarchy
/// incoming/outgoing replies carry sites; `prepare` and type hierarchy answer
/// with a bare item, and the `MessagePack` encoding is positional.
#[derive(serde::Deserialize)]
pub struct SidecarCallHierarchyCall {
    /// Display name of the symbol.
    pub name: String,
    /// Symbol kind string (e.g. "Function", "Class").
    pub kind: String,
    /// Absolute path to the file containing this symbol.
    pub file_path: String,
    /// Start line of the symbol range.
    pub line: u32,
    /// Start character offset within the start line.
    pub character: u32,
    /// End line of the symbol range.
    pub end_line: u32,
    /// End character offset within the end line.
    pub end_character: u32,
    /// Every range at which the call appears inside this symbol.
    pub from_ranges: Vec<SidecarCallSite>,
}

impl SidecarCallHierarchyCall {
    /// The bare item, for the mapping shared with `prepare` and type hierarchy.
    #[must_use]
    pub fn item(&self) -> SidecarHierarchyItem {
        SidecarHierarchyItem {
            name: self.name.clone(),
            kind: self.kind.clone(),
            file_path: self.file_path.clone(),
            line: self.line,
            character: self.character,
            end_line: self.end_line,
            end_character: self.end_character,
        }
    }
}

/// Compute the LSP location triple `(uri, range, selection_range)` shared by
/// call-hierarchy and type-hierarchy item mapping.
///
/// Both sidecars report a symbol's DECLARATION location — Roslyn's
/// `ISymbol.Locations` and FCS's `DeclarationLocation` are the identifier
/// span, not the whole declaration — so that one span is both the item's
/// `range` and the `selectionRange` LSP 3.17 says "should be selected and
/// revealed when this symbol is being picked, e.g. the name of a function".
/// A zero-width selection at the start column selected nothing at all.
///
/// Returns `None` when the sidecar's file path cannot be parsed into a URI.
pub fn hierarchy_item_location(item: &SidecarHierarchyItem) -> Option<(Uri, Range, Range)> {
    let parsed_uri = path_to_lsp_uri(&item.file_path).ok()?;
    let range = Range::new(
        Position::new(item.line, item.character),
        Position::new(item.end_line, item.end_character),
    );
    Some((parsed_uri, range, range))
}

/// Handle `prepare` for either hierarchy: the item at the cursor, mapped by
/// `map`. The sidecar method is the LSP method, so one handler serves both.
///
/// JSON `null` when no sidecar is attached or it is unreachable; an empty list
/// when it answered that nothing hierarchical sits at the cursor.
pub fn handle_prepare<T: serde::Serialize>(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    map: impl Fn(&SidecarHierarchyItem) -> Option<T>,
) -> Result<serde_json::Value> {
    let method = req.method.clone();
    with_sidecar(req, sidecar, |sidecar, at: TextDocumentPositionParams| {
        let request = SidecarPositionReq::at(&at.text_document.uri, at.position)?;
        let Some(item) = request_sidecar::<Option<SidecarHierarchyItem>, _>(
            runtime, sidecar, &method, &request,
        )?
        else {
            return Ok(serde_json::Value::Null);
        };
        debug!(
            method,
            found = item.is_some(),
            "hierarchy item from sidecar"
        );
        let result: Vec<T> = item.as_ref().and_then(map).into_iter().collect();
        Ok(serde_json::to_value(result)?)
    })
}

/// Where the item a follow-up hierarchy request (`incomingCalls`,
/// `supertypes`, …) expands sits: all the sidecar needs of either LSP item.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemAnchor {
    /// The document declaring the item.
    uri: Uri,
    /// The item's name, whose start the sidecar resolves the symbol at.
    selection_range: Range,
}

/// The params of every follow-up hierarchy request.
#[derive(serde::Deserialize)]
struct ItemParams {
    /// The item being expanded, as a previous `prepare` answered it.
    item: ItemAnchor,
}

/// Handle a follow-up hierarchy request: ask the sidecar (whose method is the
/// LSP method) for the `W` entries related to the item at its selection, and
/// answer each one `map` accepts.
///
/// An unreachable sidecar answers an empty list, the same as an item with no
/// relatives: the tree shows nothing rather than an error.
pub fn handle_related<W: serde::de::DeserializeOwned, T: serde::Serialize>(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    map: impl Fn(&W) -> Option<T>,
) -> Result<serde_json::Value> {
    let method = req.method.clone();
    with_sidecar(req, sidecar, |sidecar, params: ItemParams| {
        let request = SidecarPositionReq::at(&params.item.uri, params.item.selection_range.start)?;
        let related: Vec<W> =
            request_sidecar(runtime, sidecar, &method, &request)?.unwrap_or_default();
        debug!(
            method,
            count = related.len(),
            "related hierarchy entries from sidecar"
        );
        let result: Vec<T> = related.iter().filter_map(map).collect();
        Ok(serde_json::to_value(result)?)
    })
}
