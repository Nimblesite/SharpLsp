//! The shared navigation pipeline behind definition, type definition,
//! declaration, implementation and references: dispatch to the routed sidecar,
//! memoize in the semantic memo, and fall back to the other language's sidecar
//! for cross-language symbols. Implements [DEFINITION-ROUTING],
//! [DEFINITION-CACHE], [DEFINITION-CROSSLANG-IDENTITY].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    GotoDefinitionParams, GotoDefinitionResponse, Location, TextDocumentPositionParams,
};
use tracing::debug;

use super::{sidecar_location_to_lsp, Route, SidecarLocationListResult};
use crate::semantic_memo::{is_empty, memo, Key};
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, Caller, SidecarPositionReq};

/// Dispatch a position-based navigation request to the sidecar and return the
/// raw location-list result. Returns `Ok(None)` — for which the caller should
/// yield JSON `null` — when no sidecar is connected or the sidecar call fails.
pub(super) fn dispatch_position_request(
    req: Request,
    caller: Caller<'_>,
    (sidecar, foreign): NavRoute<'_>,
    method: &str,
) -> Result<Option<(SidecarLocationListResult, bool)>> {
    let Some(sidecar) = sidecar else {
        debug!("{method}: no sidecar available");
        return Ok(None);
    };
    let params: GotoDefinitionParams = serde_json::from_value(req.params)?;
    let at = &params.text_document_position_params;
    let request = SidecarPositionReq::at(&at.text_document.uri, at.position)?;
    debug!(
        method,
        file = %request.file_path,
        line = request.line,
        character = request.character,
        "request dispatching to sidecar"
    );
    let found: Option<SidecarLocationListResult> =
        request_sidecar(caller, sidecar, method, &request)?;
    Ok(found.map(|result| crate::cross_language::in_fsharp_source(caller, foreign, result)))
}

/// The sidecar a navigation request goes to, and the F# sidecar that places
/// the F# symbols its decompiled answers show. [DEFINITION-CROSSLANG-IDENTITY]
pub(super) type NavRoute<'a> = (
    Option<&'a Arc<SidecarManager>>,
    Option<&'a Arc<SidecarManager>>,
);

/// An LSP answer and whether it is settled: an unsettled one is answered but
/// never memoized, so the next request asks again.
pub(super) type Answer = (serde_json::Value, bool);

/// Every location the sidecar found (definition, implementation), or only the
/// first (type definition, declaration) when `multi` is off.
pub(super) fn locations(
    req: Request,
    caller: Caller<'_>,
    route: NavRoute<'_>,
    method: &str,
    multi: bool,
) -> Result<Answer> {
    let Some((result, settled)) = dispatch_position_request(req, caller, route, method)? else {
        return Ok((serde_json::Value::Null, true));
    };
    let mut found = result.locations.iter().filter_map(sidecar_location_to_lsp);
    let response = if multi {
        let all: Vec<Location> = found.collect();
        (!all.is_empty()).then(|| GotoDefinitionResponse::Array(all))
    } else {
        found.next().map(GotoDefinitionResponse::Scalar)
    };
    Ok((serde_json::to_value(response)?, settled))
}

/// Locations from the primary sidecar, else from the cross-language fallback
/// (C# ↔ F#) when the primary found none.
pub(super) fn locations_with_fallback(
    req: Request,
    route: &Route,
    method: &str,
    multi: bool,
) -> Result<Answer> {
    let caller = route.caller();
    let fallback = route.fallback.as_ref();
    let answer = locations(req.clone(), caller, route.nav(), method, multi)?;
    Ok(or_fallback(answer, fallback, method, |other| {
        locations(req, caller, (Some(other), None), method, multi)
    }))
}

/// `answer`, unless it is empty and the cross-language `fallback` sidecar
/// (C# ↔ F#) answers instead. A fallback that fails or answers empty leaves
/// `answer` standing: it never blocks the primary answer.
pub(super) fn or_fallback(
    answer: Answer,
    fallback: Option<&Arc<SidecarManager>>,
    method: &str,
    ask: impl FnOnce(&Arc<SidecarManager>) -> Result<Answer>,
) -> Answer {
    let Some(other) = fallback.filter(|_| is_empty(&answer.0)) else {
        return answer;
    };
    debug!(method, "cross-language fallback");
    match ask(other) {
        Ok(found) if !is_empty(&found.0) => found,
        Ok(_) => {
            debug!(method, "cross-language fallback returned empty");
            answer
        }
        Err(err) => {
            debug!(method, error = %format_args!("{err:#}"), "cross-language fallback failed");
            answer
        }
    }
}

/// Answer `req` from the semantic memo when the document's version, the
/// position and every workspace input match an earlier answer under `method`;
/// otherwise `ask` the compiler and memoize a settled answer. An answer that
/// still shows an F# symbol in decompiled source, because the F# sidecar could
/// not place it yet, is unsettled. [DEFINITION-CACHE] [REFERENCES-SALSA]
/// [DEFINITION-CROSSLANG-IDENTITY]
pub(super) fn memoized(
    req: Request,
    vfs: &crate::vfs::Vfs,
    method: &'static str,
    ask: impl FnOnce(Request) -> Result<Answer> + Send + 'static,
) -> Result<serde_json::Value> {
    let at: TextDocumentPositionParams = serde_json::from_value(req.params.clone())?;
    let key = Key {
        uri: at.text_document.uri.as_str().to_owned(),
        method,
        line: at.position.line,
        character: at.position.character,
    };
    let version = vfs.get_version(&at.text_document.uri).unwrap_or(0);
    let (value, hit) = memo().answer(&key, version, Box::new(move || ask(req)))?;
    debug!(method, hit, "semantic memo answered");
    Ok(value)
}
