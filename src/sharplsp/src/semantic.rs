//! Semantic request handlers routed through the .NET sidecar.
//! Navigation requests implement [DEFINITION-ROUTING].
//!
//! Each handler serializes the LSP params into a sidecar request,
//! forwards it via the `SidecarManager`, and translates the response
//! back into LSP types.

pub(crate) mod completion;
pub(crate) mod hover;
mod navigation;
pub(crate) mod rename;
pub(crate) mod requests;

use navigation::{locations_with_fallback, memoized, or_fallback, NavRoute};

use rename::SidecarRenameIdentityResult;

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::request::{
    DocumentHighlightRequest, GotoDeclaration, GotoDefinition, GotoImplementation,
    GotoTypeDefinition, HoverRequest, References, Request as _,
};
use lsp_types::{
    DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, Location, Position, Range,
    ReferenceParams, Uri,
};
use lspkit_server::CancellationToken;
use tracing::{debug, warn};

use crate::paths::path_to_lsp_uri;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, Caller, SidecarPositionReq};
use crate::vfs::Vfs;

/// What one semantic request runs with: owned, so the semantic memo can run
/// its compiler round trip. [DEFINITION-ROUTING]
#[derive(Clone)]
pub struct Route {
    /// Drives the sidecar exchanges.
    pub runtime: tokio::runtime::Handle,
    /// Ends the exchanges when the request is cancelled or superseded.
    pub cancel: CancellationToken,
    /// The sidecar that owns the request's document.
    pub primary: Option<Arc<SidecarManager>>,
    /// The other language's sidecar, for cross-language symbols (C# ↔ F#).
    pub fallback: Option<Arc<SidecarManager>>,
}

impl Route {
    /// Who asks the sidecars on this request's behalf.
    pub(crate) fn caller(&self) -> Caller<'_> {
        Caller {
            runtime: &self.runtime,
            cancel: Some(&self.cancel),
        }
    }

    /// The primary sidecar, and the F# sidecar that places F# symbols.
    fn nav(&self) -> NavRoute<'_> {
        (self.primary.as_ref(), self.fallback.as_ref())
    }
}

/// Answer hover, definition, type definition, declaration, implementation,
/// references or document highlight through the request's sidecars.
/// [DEFINITION-ROUTING] [REFERENCES-ROUTING] [HOVER-ROUTING]
pub fn handle(req: Request, vfs: &Vfs, route: Route) -> Result<serde_json::Value> {
    match req.method.as_str() {
        HoverRequest::METHOD => hover::handle_hover(req, vfs, route),
        GotoDefinition::METHOD => located(req, vfs, route, GotoDefinition::METHOD, true),
        GotoTypeDefinition::METHOD => located(req, vfs, route, GotoTypeDefinition::METHOD, false),
        GotoDeclaration::METHOD => located(req, vfs, route, GotoDeclaration::METHOD, false),
        GotoImplementation::METHOD => {
            let method = GotoImplementation::METHOD;
            locations_with_fallback(req, &route, method, true).map(|(value, _)| value)
        }
        References::METHOD => handle_references(req, vfs, route),
        DocumentHighlightRequest::METHOD => {
            let method = DocumentHighlightRequest::METHOD;
            memoized(req, vfs, method, move |req| {
                dispatch_document_highlight(req, route.caller(), route.primary.as_ref())
                    .map(|value| (value, true))
            })
        }
        method => Err(anyhow::anyhow!("unexpected semantic method: {method}")),
    }
}

/// Memoized locations with cross-language fallback (C# ↔ F#).
fn located(
    req: Request,
    vfs: &Vfs,
    route: Route,
    method: &'static str,
    multi: bool,
) -> Result<serde_json::Value> {
    memoized(req, vfs, method, move |req| {
        locations_with_fallback(req, &route, method, multi)
    })
}

/// Memoized `textDocument/references` with cross-language fallback; with and
/// without the declaration are separate questions. [REFERENCES-ROUTING]
fn handle_references(req: Request, vfs: &Vfs, route: Route) -> Result<serde_json::Value> {
    let params: ReferenceParams = serde_json::from_value(req.params.clone())?;
    let question = if params.context.include_declaration {
        "textDocument/references:decl"
    } else {
        "textDocument/references:nodecl"
    };
    memoized(req, vfs, question, move |req| {
        let (caller, fallback) = (route.caller(), route.fallback.as_ref());
        let own = handle_references_nav(req.clone(), caller, route.nav())?;
        Ok(or_fallback(
            (own, true),
            fallback,
            References::METHOD,
            |other| {
                handle_references_nav(req, caller, (Some(other), None)).map(|value| (value, true))
            },
        ))
    })
}

/// Dispatch document highlight request to the sidecar.
fn dispatch_document_highlight(
    req: Request,
    caller: Caller<'_>,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: DocumentHighlightParams| {
        let at = &params.text_document_position_params;
        let request = SidecarPositionReq::at(&at.text_document.uri, at.position)?;
        debug!(
            file = %request.file_path,
            line = request.line,
            character = request.character,
            "DocumentHighlight request dispatching to sidecar"
        );
        let method = "textDocument/documentHighlight";
        let Some(result) = request_sidecar::<SidecarDocumentHighlightListResult, _>(
            caller, sidecar, method, &request,
        )?
        else {
            return Ok(serde_json::Value::Null);
        };
        let highlights: Vec<DocumentHighlight> = result
            .highlights
            .iter()
            .map(to_document_highlight)
            .collect();
        Ok(serde_json::to_value(highlights)?)
    })
}

/// One sidecar highlight as an LSP `DocumentHighlight`; kind 3 writes, 2 reads.
fn to_document_highlight(h: &SidecarDocumentHighlightResult) -> DocumentHighlight {
    DocumentHighlight {
        range: Range::new(
            Position::new(h.start_line, h.start_character),
            Position::new(h.end_line, h.end_character),
        ),
        kind: Some(match h.kind {
            3 => DocumentHighlightKind::WRITE,
            2 => DocumentHighlightKind::READ,
            _ => DocumentHighlightKind::TEXT,
        }),
    }
}

/// Inner handler for references (serializes `ReferencesRequest` with `include_declaration`).
/// References from the sidecar that owns the document, merged with the other
/// language's uses of the same symbol, found by its identity.
/// [REFERENCES-CROSS-LANGUAGE]
fn handle_references_nav(
    req: Request,
    caller: Caller<'_>,
    (sidecar, other): NavRoute<'_>,
) -> Result<serde_json::Value> {
    with_sidecar(req, sidecar, |sidecar, params: ReferenceParams| {
        let at = SidecarPositionReq::at(
            &params.text_document_position.text_document.uri,
            params.text_document_position.position,
        )?;
        let include_declaration = params.context.include_declaration;
        let Some(own) = own_references(caller, sidecar, &at, include_declaration)? else {
            return Ok(serde_json::Value::Null);
        };
        let foreign = crate::cross_language::foreign_references(
            caller,
            sidecar,
            other,
            &at,
            include_declaration,
        );
        Ok(serde_json::to_value(crate::cross_language::merged(
            own, foreign,
        ))?)
    })
}

/// The owning sidecar's references for the symbol at `at`; `None` when it
/// could not answer, which is the whole request's `null`.
fn own_references(
    caller: Caller<'_>,
    sidecar: &SidecarManager,
    at: &SidecarPositionReq,
    include_declaration: bool,
) -> Result<Option<Vec<Location>>> {
    debug!(
        file = %at.file_path,
        line = at.line,
        character = at.character,
        include_declaration,
        "References request dispatching to sidecar"
    );
    let request = SidecarReferencesReq {
        file_path: at.file_path.clone(),
        line: at.line,
        character: at.character,
        include_declaration,
    };
    let method = "textDocument/references";
    let result: Option<SidecarLocationListResult> =
        request_sidecar(caller, sidecar, method, &request)?;
    Ok(result.map(|found| {
        found
            .locations
            .iter()
            .filter_map(sidecar_location_to_lsp)
            .collect()
    }))
}

/// Convert a sidecar `LocationResult` to an LSP `Location`.
pub(crate) fn sidecar_location_to_lsp(loc: &SidecarLocationResult) -> Option<Location> {
    let uri: Uri = path_to_lsp_uri(&loc.file_path).ok()?;
    Some(Location {
        uri,
        range: Range::new(
            Position::new(loc.line, loc.character),
            Position::new(loc.end_line, loc.end_character),
        ),
    })
}

// ── Sidecar wire types (MessagePack) ──────────────────────────────

/// Notify the sidecar that a document's text has changed.
pub fn notify_did_change(
    file_path: &str,
    new_text: &str,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) {
    runtime.block_on(notify_did_change_async(file_path, new_text, sidecar));
}

/// Async core of [`notify_did_change`], reused by the background reload pass.
pub async fn notify_did_change_async(
    file_path: &str,
    new_text: &str,
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
    if let Err(err) = sidecar.request("textDocument/didChange", payload).await {
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

/// A single location result from the sidecar (definition, references, etc.).
#[derive(serde::Deserialize)]
pub(crate) struct SidecarLocationResult {
    /// Absolute filesystem path of the target file.
    file_path: String,
    /// Start line of the target range.
    pub(crate) line: u32,
    /// Start character of the target range.
    pub(crate) character: u32,
    /// End line of the target range.
    pub(crate) end_line: u32,
    /// End character of the target range.
    pub(crate) end_character: u32,
    /// For decompiled source of an F# project's symbol, the symbol's identity,
    /// which the F# sidecar places. [DEFINITION-CROSSLANG-IDENTITY]
    #[serde(default)]
    pub(crate) symbol: Option<SidecarRenameIdentityResult>,
}

/// Sidecar response containing a list of locations.
#[derive(serde::Deserialize)]
pub(crate) struct SidecarLocationListResult {
    /// The resolved locations.
    pub(crate) locations: Vec<SidecarLocationResult>,
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
