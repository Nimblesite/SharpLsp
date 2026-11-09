//! The shared navigation pipeline behind definition, type definition,
//! declaration, implementation and references: dispatch to the routed sidecar,
//! cache by document version, and fall back to the other language's sidecar
//! for cross-language symbols. Implements [DEFINITION-ROUTING],
//! [DEFINITION-CROSSLANG-IDENTITY].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    GotoDefinitionParams, GotoDefinitionResponse, Location, TextDocumentPositionParams,
};
use tracing::debug;

use super::{sidecar_location_to_lsp, SidecarLocationListResult};
use crate::nav_cache::is_empty_nav_result;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, SidecarPositionReq};

/// Dispatch a position-based navigation request to the sidecar and return the
/// raw location-list result. Returns `Ok(None)` — for which the caller should
/// yield JSON `null` — when no sidecar is connected or the sidecar call fails.
pub(super) fn dispatch_position_request(
    req: Request,
    runtime: &tokio::runtime::Runtime,
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
        request_sidecar(runtime, sidecar, method, &request)?;
    Ok(found.map(|result| crate::cross_language::in_fsharp_source(runtime, foreign, result)))
}

/// The sidecar a navigation request goes to, and the F# sidecar that places
/// the F# symbols its decompiled answers show. [DEFINITION-CROSSLANG-IDENTITY]
pub(super) type NavRoute<'a> = (
    Option<&'a Arc<SidecarManager>>,
    Option<&'a Arc<SidecarManager>>,
);

/// Shared handler for multi-location navigation requests
/// (definition, implementation).
pub(super) fn handle_multi_location_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    route: NavRoute<'_>,
    method: &str,
) -> Result<(serde_json::Value, bool)> {
    let Some((result, settled)) = dispatch_position_request(req, runtime, route, method)? else {
        return Ok((serde_json::Value::Null, true));
    };
    let locations: Vec<Location> = result
        .locations
        .into_iter()
        .filter_map(|loc| sidecar_location_to_lsp(&loc))
        .collect();

    let response = (!locations.is_empty()).then(|| GotoDefinitionResponse::Array(locations));
    Ok((serde_json::to_value(response)?, settled))
}

/// Cached navigation with cross-language fallback.
///
/// Tries the primary sidecar first. If it returns empty/null,
/// retries with the fallback sidecar (cross-language C# ↔ F#).
/// If the fallback also fails (e.g. sidecar not running), returns
/// the original result without blocking.
#[expect(
    clippy::too_many_arguments,
    reason = "cross-language fallback requires both sidecars plus cached-nav params"
)]
pub(super) fn handle_cached_nav_with_fallback(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    fallback: Option<&Arc<SidecarManager>>,
    method: &str,
    multi: bool,
) -> Result<serde_json::Value> {
    let route = (sidecar, fallback);
    let value = handle_cached_nav(req.clone(), vfs, nav_cache, runtime, route, method, multi)?;
    Ok(or_fallback(value, fallback, method, |fb| {
        handle_cached_nav(
            req,
            vfs,
            nav_cache,
            runtime,
            (Some(fb), None),
            method,
            multi,
        )
    }))
}

/// `value`, unless it is empty and the cross-language `fallback` sidecar
/// (C# ↔ F#) answers instead. A fallback that fails or answers empty leaves
/// `value` standing: it never blocks the primary answer.
pub(super) fn or_fallback(
    value: serde_json::Value,
    fallback: Option<&Arc<SidecarManager>>,
    method: &str,
    ask: impl FnOnce(&Arc<SidecarManager>) -> Result<serde_json::Value>,
) -> serde_json::Value {
    let Some(fb) = fallback.filter(|_| is_empty_nav_result(&value)) else {
        return value;
    };
    debug!(method, "cross-language fallback");
    match ask(fb) {
        Ok(fb_value) if !is_empty_nav_result(&fb_value) => fb_value,
        Ok(_) => {
            debug!(method, "cross-language fallback returned empty");
            value
        }
        Err(err) => {
            debug!(method, error = %format_args!("{err:#}"), "cross-language fallback failed");
            value
        }
    }
}

/// Answer `req` from the navigation cache when the document's version and the
/// request position match an earlier answer under `method`; otherwise
/// `dispatch` it and remember the answer.
pub(super) fn cached_at_position(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    method: &str,
    dispatch: impl FnOnce(Request) -> Result<serde_json::Value>,
) -> Result<serde_json::Value> {
    cached_at_position_when_settled(req, vfs, nav_cache, method, |req| {
        dispatch(req).map(|value| (value, true))
    })
}

/// [`cached_at_position`] for an answer that may not be settled yet: one that
/// still shows an F# symbol in decompiled source, because the F# sidecar could
/// not place it yet, is answered but not remembered, so the next request asks
/// again. [DEFINITION-CROSSLANG-IDENTITY]
pub(super) fn cached_at_position_when_settled(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    method: &str,
    dispatch: impl FnOnce(Request) -> Result<(serde_json::Value, bool)>,
) -> Result<serde_json::Value> {
    let at: TextDocumentPositionParams = serde_json::from_value(req.params.clone())?;
    let uri = at.text_document.uri.as_str();
    let version = vfs.get_version(&at.text_document.uri).unwrap_or(0);
    let (line, character) = (at.position.line, at.position.character);
    if let Some(cached) = cached_nav_hit(nav_cache, uri, version, line, character, method, method) {
        return Ok(cached);
    }
    let (value, settled) = dispatch(req)?;
    if settled {
        nav_cache.insert(uri, version, line, character, method, value.clone());
    }
    Ok(value)
}

/// Look up a navigation result in the cache, logging a hit under `label`.
///
/// Returns the cloned cached value on hit, or `None` when absent/stale.
pub(super) fn cached_nav_hit(
    nav_cache: &crate::nav_cache::NavCache,
    uri: &str,
    version: i32,
    line: u32,
    character: u32,
    method: &str,
    label: &str,
) -> Option<serde_json::Value> {
    let cached = nav_cache.get(uri, version, line, character, method)?;
    debug!("{label} cache hit");
    Some(cached.clone())
}

/// Cached navigation handler — checks cache before dispatching to sidecar.
///
/// `multi` controls whether to use multi-location (definition) or
/// single-location (typeDefinition, declaration) response format.
pub(super) fn handle_cached_nav(
    req: Request,
    vfs: &crate::vfs::Vfs,
    nav_cache: &mut crate::nav_cache::NavCache,
    runtime: &tokio::runtime::Runtime,
    route: NavRoute<'_>,
    method: &str,
    multi: bool,
) -> Result<serde_json::Value> {
    cached_at_position_when_settled(req, vfs, nav_cache, method, |req| {
        if multi {
            handle_multi_location_nav(req, runtime, route, method)
        } else {
            handle_single_location_nav(req, runtime, route, method)
        }
    })
}

/// Shared handler for single-location navigation requests
/// (typeDefinition, declaration).
pub(super) fn handle_single_location_nav(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    route: NavRoute<'_>,
    method: &str,
) -> Result<(serde_json::Value, bool)> {
    let Some((result, settled)) = dispatch_position_request(req, runtime, route, method)? else {
        return Ok((serde_json::Value::Null, true));
    };
    let response = result.locations.first().and_then(|loc| {
        let location = sidecar_location_to_lsp(loc)?;
        Some(GotoDefinitionResponse::Scalar(location))
    });

    Ok((serde_json::to_value(response)?, settled))
}
