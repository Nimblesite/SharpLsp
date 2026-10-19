//! Razor documents (`.razor`, `.cshtml`) in the host.
//!
//! The host has no Razor grammar, so the syntax requests it answers from
//! tree-sitter for C# go to the C# sidecar for Razor, whose Razor compiler is
//! the parser. The two Razor completion triggers are useless in C# and F#
//! documents, so those answer at once. Implements [RAZOR-ARCHITECTURE-ROUTING].

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    CompletionParams, FoldingRange, FoldingRangeParams, LinkedEditingRangeParams,
    LinkedEditingRanges, Position, Range, Uri,
};

use crate::semantic::SidecarLocationListResult;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::LangId;
use crate::utils::{SidecarFileReq, SidecarPositionReq};

/// Completion trigger characters that only Razor markup uses.
pub const MARKUP_TRIGGERS: [&str; 2] = ["<", "@"];

/// Whether `uri` names a Razor document.
pub fn is_razor(uri: &Uri) -> bool {
    LangId::from_uri(uri) == Some(LangId::Razor)
}

/// Whether a completion request was triggered by a Razor-only character in a
/// document that is not Razor, so it can answer `null` without a sidecar.
pub fn is_markup_trigger_outside_razor(params: &CompletionParams) -> bool {
    let triggered_by_markup = params
        .context
        .as_ref()
        .and_then(|context| context.trigger_character.as_deref())
        .is_some_and(|character| MARKUP_TRIGGERS.contains(&character));
    triggered_by_markup && !is_razor(&params.text_document_position.text_document.uri)
}

/// Handle `textDocument/foldingRange` for a Razor document via the C# sidecar.
pub fn handle_folding_ranges(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: FoldingRangeParams = serde_json::from_value(req.params)?;
    let request = SidecarFileReq {
        file_path: crate::paths::uri_to_path(params.text_document.uri.as_str())?,
    };
    let folds: Vec<(u32, u32)> = fetch(runtime, sidecar, "textDocument/foldingRange", &request)?;
    let ranges: Vec<FoldingRange> = folds.into_iter().map(to_folding_range).collect();
    Ok(serde_json::to_value(ranges)?)
}

/// Handle `textDocument/linkedEditingRange` for a Razor document via the C#
/// sidecar: the start and end tag names of the element at the position.
pub fn handle_linked_editing_range(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: LinkedEditingRangeParams = serde_json::from_value(req.params)?;
    let at = &params.text_document_position_params;
    let request = SidecarPositionReq::at(&at.text_document.uri, at.position)?;
    let found: SidecarLocationListResult = fetch(
        runtime,
        sidecar,
        "textDocument/linkedEditingRange",
        &request,
    )?;
    let ranges: Vec<Range> = found.locations.iter().map(to_range).collect();
    Ok(if ranges.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::to_value(LinkedEditingRanges {
            ranges,
            word_pattern: None,
        })?
    })
}

/// Send one request to the sidecar that owns Razor and decode its answer.
fn fetch<T: serde::de::DeserializeOwned>(
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
    method: &str,
    request: &impl serde::Serialize,
) -> Result<T> {
    let Some(sidecar) = sidecar else {
        anyhow::bail!("C# sidecar unavailable; cannot answer {method} for a Razor document");
    };
    let payload = rmp_serde::to_vec(request)?;
    let bytes = runtime.block_on(sidecar.request(method, payload))?;
    Ok(rmp_serde::from_slice(&bytes)?)
}

/// A sidecar fold `(start_line, end_line)` as an LSP folding range.
const fn to_folding_range((start_line, end_line): (u32, u32)) -> FoldingRange {
    FoldingRange {
        start_line,
        start_character: None,
        end_line,
        end_character: None,
        kind: None,
        collapsed_text: None,
    }
}

/// A sidecar location's range.
fn to_range(location: &crate::semantic::SidecarLocationResult) -> Range {
    Range::new(
        Position::new(location.line, location.character),
        Position::new(location.end_line, location.end_character),
    )
}

#[cfg(test)]
mod tests {
    #![expect(
        clippy::expect_used,
        reason = "test code — panics are the correct failure mode"
    )]
    use super::*;

    fn completion(uri: &str, trigger: Option<&str>) -> CompletionParams {
        serde_json::from_value(serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 1 },
            "context": { "triggerKind": 2, "triggerCharacter": trigger },
        }))
        .expect("valid completion params")
    }

    /// `<` and `@` complete markup only in Razor documents; C# and F#
    /// documents answer at once. [RAZOR-ARCHITECTURE-ROUTING]
    #[test]
    fn markup_triggers_short_circuit_only_outside_razor() {
        assert!(is_markup_trigger_outside_razor(&completion(
            "file:///a/Program.cs",
            Some("<")
        )));
        assert!(is_markup_trigger_outside_razor(&completion(
            "file:///a/Lib.fs",
            Some("@")
        )));
        assert!(!is_markup_trigger_outside_razor(&completion(
            "file:///a/Board.razor",
            Some("<")
        )));
        assert!(!is_markup_trigger_outside_razor(&completion(
            "file:///a/Index.cshtml",
            Some("@")
        )));
        assert!(!is_markup_trigger_outside_razor(&completion(
            "file:///a/Program.cs",
            Some(".")
        )));
        assert!(!is_markup_trigger_outside_razor(&completion(
            "file:///a/Program.cs",
            None
        )));
    }

    /// A sidecar fold keeps its lines and claims no characters or kind.
    #[test]
    fn sidecar_folds_become_line_folding_ranges() {
        let fold = to_folding_range((6, 9));
        assert_eq!((fold.start_line, fold.end_line), (6, 9));
        assert_eq!((fold.start_character, fold.end_character), (None, None));
        assert!(fold.kind.is_none());
    }
}
