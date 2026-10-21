//! Symbols that cross the C# ↔ F# boundary, found in the other sidecar by
//! their identity: the assembly that declares them and their XML doc
//! signature, the only name both compilers give a symbol.
//!
//! C# sees an F# project only as its built DLL, so definition from C# or a
//! Razor file onto an F# symbol lands in decompiled source. That location
//! carries the symbol's identity, and the F# sidecar answers its F#
//! declaration instead. References merge each side's uses the same way.
//! Implements [DEFINITION-CROSSLANG-IDENTITY], [REFERENCES-CROSS-LANGUAGE]
//! and [RAZOR-FSHARP].

use std::sync::Arc;

use anyhow::Result;
use lsp_types::Location;
use tracing::debug;

use crate::semantic::{
    request_symbol_identity, sidecar_location_to_lsp, sidecar_workspace_loaded,
    SidecarLocationListResult, SidecarLocationResult, SidecarRenameIdentityResult,
};
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, SidecarPositionReq};

/// The request naming a symbol by identity, matching the sidecars'
/// `ForeignSymbolRequest` key layout.
#[derive(serde::Serialize)]
struct ForeignSymbolReq<'a> {
    /// Simple name of the assembly that declares the symbol.
    assembly_name: &'a str,
    /// The symbol's XML doc signature.
    xml_doc_sig: &'a str,
    /// Whether references include the declaration.
    include_declaration: bool,
}

/// `result` with each decompiled location of an F# project's symbol replaced
/// by that symbol's F# declarations, where the F# sidecar finds them, and
/// whether the answer is settled. A location without an identity stays; one
/// the F# sidecar cannot place yet stays too, and leaves the answer unsettled,
/// since the F# sidecar may still be loading. With no F# sidecar, nothing can
/// place it, so the decompiled answer is final.
pub fn in_fsharp_source(
    runtime: &tokio::runtime::Runtime,
    fsharp: Option<&Arc<SidecarManager>>,
    result: SidecarLocationListResult,
) -> (SidecarLocationListResult, bool) {
    let Some(fsharp) = fsharp else {
        return (result, true);
    };
    let (placed, settled): (Vec<_>, Vec<_>) = result
        .locations
        .into_iter()
        .map(|location| declarations_of(runtime, fsharp, location))
        .unzip();
    let locations = placed.into_iter().flatten().collect();
    (
        SidecarLocationListResult { locations },
        settled.into_iter().all(|done| done),
    )
}

/// The F# declarations of the symbol `location` shows, else `location`, and
/// whether that is final: a location naming no F# symbol always is.
fn declarations_of(
    runtime: &tokio::runtime::Runtime,
    fsharp: &Arc<SidecarManager>,
    location: SidecarLocationResult,
) -> (Vec<SidecarLocationResult>, bool) {
    let Some(symbol) = location.symbol.as_ref().filter(|symbol| symbol.found) else {
        return (vec![location], true);
    };
    by_identity(
        runtime,
        fsharp,
        "workspace/declarationForeign",
        symbol,
        true,
    )
    .inspect_err(|err| debug!(error = %format_args!("{err:#}"), "F# declaration lookup failed"))
    .ok()
    .filter(|declared| !declared.is_empty())
    .map_or_else(|| (vec![location], false), |declared| (declared, true))
}

/// The other language's uses of the symbol at `at`, found by its identity:
/// none when the other sidecar has no workspace, the symbol has no identity,
/// or either sidecar fails, so the primary answer always stands.
pub fn foreign_references(
    runtime: &tokio::runtime::Runtime,
    primary: &SidecarManager,
    other: Option<&Arc<SidecarManager>>,
    at: &SidecarPositionReq,
    include_declaration: bool,
) -> Vec<Location> {
    let Some(other) = other else {
        return Vec::new();
    };
    references_by_identity(runtime, primary, other, at, include_declaration).unwrap_or_else(|err| {
        debug!(error = %format_args!("{err:#}"), "cross-language references failed");
        Vec::new()
    })
}

/// The other sidecar's references to the symbol at `at`, found by the identity
/// the primary sidecar names it with; none when it names no foreign symbol.
fn references_by_identity(
    runtime: &tokio::runtime::Runtime,
    primary: &SidecarManager,
    other: &Arc<SidecarManager>,
    at: &SidecarPositionReq,
    include_declaration: bool,
) -> Result<Vec<Location>> {
    if !sidecar_workspace_loaded(runtime, other)? {
        return Ok(Vec::new());
    }
    let identity = request_symbol_identity(runtime, primary, at)?;
    if !identity.found {
        return Ok(Vec::new());
    }
    let method = "workspace/referencesForeign";
    let found = by_identity(runtime, other, method, &identity, include_declaration)?;
    Ok(found.iter().filter_map(sidecar_location_to_lsp).collect())
}

/// Ask `sidecar` for the locations `method` finds for the symbol `identity`.
fn by_identity(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    method: &str,
    identity: &SidecarRenameIdentityResult,
    include_declaration: bool,
) -> Result<Vec<SidecarLocationResult>> {
    let request = ForeignSymbolReq {
        assembly_name: &identity.assembly_name,
        xml_doc_sig: &identity.xml_doc_sig,
        include_declaration,
    };
    let found: Option<SidecarLocationListResult> =
        request_sidecar(runtime, sidecar, method, &request)?;
    Ok(found.map_or_else(Vec::new, |result| result.locations))
}

/// `primary` followed by each of `foreign` it does not already hold.
pub fn merged(primary: Vec<Location>, foreign: Vec<Location>) -> Vec<Location> {
    foreign.into_iter().fold(primary, |mut all, location| {
        if !all.contains(&location) {
            all.push(location);
        }
        all
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::{Position, Range, Uri};
    use std::str::FromStr;

    /// A sidecar whose process cannot start, so every request to it fails.
    fn unreachable_sidecar() -> Arc<SidecarManager> {
        Arc::new(SidecarManager::new(
            "unreachable",
            "sharplsp-no-such-sidecar",
            Vec::new(),
            "sharplsp-no-such-sidecar.sock",
        ))
    }

    /// A sidecar location as the wire carries it: `symbol` names an F#
    /// project's symbol as `(found, assembly, xml doc signature)`.
    fn location(line: u32, symbol: Option<(bool, &str, &str)>) -> Option<SidecarLocationResult> {
        let wire = ("/a/Domain.dll.cs", line, 4, line, 10, symbol);
        rmp_serde::from_slice(&rmp_serde::to_vec(&wire).ok()?).ok()
    }

    fn lines(result: &SidecarLocationListResult) -> Vec<u32> {
        result.locations.iter().map(|found| found.line).collect()
    }

    /// With no F# sidecar nothing can place a decompiled location, so the
    /// answer is final as it stands. [DEFINITION-CROSSLANG-IDENTITY]
    #[test]
    fn without_an_fsharp_sidecar_decompiled_locations_are_final() {
        let runtime = tokio::runtime::Runtime::new().ok();
        let result = SidecarLocationListResult {
            locations: [
                location(3, Some((true, "Domain", "T:Domain.Player"))),
                location(7, None),
            ]
            .into_iter()
            .flatten()
            .collect(),
        };
        let placed = runtime.map(|runtime| in_fsharp_source(&runtime, None, result));
        let (result, settled) = placed.unzip();
        assert_eq!(settled, Some(true), "nothing could ever place it");
        assert_eq!(
            result.as_ref().map(lines),
            Some(vec![3, 7]),
            "every location stays"
        );
    }

    /// A location the F# sidecar cannot place stays decompiled and leaves the
    /// answer unsettled, so it is asked again; a location naming no F# symbol,
    /// or one whose identity was not found, never asks. [DEFINITION-CROSSLANG-IDENTITY]
    #[test]
    fn an_unplaced_fsharp_symbol_stays_decompiled_and_unsettled() {
        let runtime = tokio::runtime::Runtime::new().ok();
        let fsharp = unreachable_sidecar();
        let answer = |locations: Vec<Option<SidecarLocationResult>>| {
            let result = SidecarLocationListResult {
                locations: locations.into_iter().flatten().collect(),
            };
            runtime
                .as_ref()
                .map(|runtime| in_fsharp_source(runtime, Some(&fsharp), result))
                .map(|(result, settled)| (lines(&result), settled))
        };
        assert_eq!(
            answer(vec![
                location(3, Some((true, "Domain", "T:Domain.Player"))),
                location(7, None)
            ]),
            Some((vec![3, 7], false)),
            "the F# sidecar failed, so the decompiled answer stands for now"
        );
        assert_eq!(
            answer(vec![location(5, Some((false, "", ""))), location(7, None)]),
            Some((vec![5, 7], true)),
            "no F# symbol to place: the answer is final"
        );
    }

    /// No other sidecar, or one that fails, adds no references: the primary
    /// answer always stands. [REFERENCES-CROSS-LANGUAGE]
    #[test]
    fn foreign_references_are_none_without_a_working_other_sidecar() {
        let runtime = tokio::runtime::Runtime::new().ok();
        let primary = unreachable_sidecar();
        let other = unreachable_sidecar();
        let at = SidecarPositionReq {
            file_path: "/a/Board.razor".to_string(),
            line: 3,
            character: 9,
        };
        let found = |other: Option<&Arc<SidecarManager>>| {
            runtime
                .as_ref()
                .map(|runtime| foreign_references(runtime, &primary, other, &at, true))
        };
        assert_eq!(found(None), Some(Vec::new()), "no other sidecar");
        assert_eq!(
            found(Some(&other)),
            Some(Vec::new()),
            "the other sidecar fails"
        );
    }

    fn at(uri: &str, line: u32) -> Option<Location> {
        Some(Location {
            uri: Uri::from_str(uri).ok()?,
            range: Range::new(Position::new(line, 0), Position::new(line, 4)),
        })
    }

    /// Each side's answers once, the primary's first. [REFERENCES-CROSS-LANGUAGE]
    #[test]
    fn merged_keeps_the_primary_order_and_drops_duplicates() {
        let primary: Vec<Location> = [
            at("file:///a/Leaders.razor", 6),
            at("file:///a/Scores.fs", 3),
        ]
        .into_iter()
        .flatten()
        .collect();
        let foreign: Vec<Location> = [at("file:///a/Scores.fs", 3), at("file:///a/Scores.fs", 9)]
            .into_iter()
            .flatten()
            .collect();
        let all = merged(primary.clone(), foreign.clone());
        assert_eq!(all.len(), 3);
        assert_eq!(all.first(), primary.first());
        assert_eq!(all.last(), foreign.last());
        assert_eq!(merged(Vec::new(), foreign.clone()), foreign);
    }

    /// The wire request is positional, in the sidecars' key order.
    #[test]
    fn foreign_symbol_request_is_positional() {
        let request = ForeignSymbolReq {
            assembly_name: "Domain",
            xml_doc_sig: "T:Domain.Player",
            include_declaration: true,
        };
        let decoded: Option<(String, String, bool)> = rmp_serde::to_vec(&request)
            .ok()
            .and_then(|bytes| rmp_serde::from_slice(&bytes).ok());
        assert_eq!(
            decoded,
            Some(("Domain".into(), "T:Domain.Player".into(), true))
        );
    }
}
