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
    LinkedEditingRanges, Position, Range, TextDocumentIdentifier, Uri,
};

use crate::semantic::SidecarLocationListResult;
use crate::sidecar::manager::SidecarManager;
use crate::tree_sitter_parse::LangId;
use crate::utils::{SidecarFileReq, SidecarPositionReq};

/// Completion trigger characters that only Razor markup uses.
pub const MARKUP_TRIGGERS: [&str; 2] = ["<", "@"];

/// The request that answers a Razor document's HTML projection.
pub const HTML_PROJECTION: &str = "sharplsp/razor/htmlProjection";

/// Params of [`HTML_PROJECTION`]: the Razor document.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HtmlProjectionParams {
    /// The Razor document to project.
    text_document: TextDocumentIdentifier,
    /// Only project markup at this caret; absent requests the whole projection.
    position: Option<Position>,
}

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
    let request = file_request(&params.text_document.uri)?;
    let folds: Vec<(u32, u32)> = fetch(runtime, sidecar, "textDocument/foldingRange", &request)?;
    let ranges: Vec<FoldingRange> = folds.into_iter().map(to_folding_range).collect();
    Ok(serde_json::to_value(ranges)?)
}

/// Handle [`HTML_PROJECTION`] via the C# sidecar: `{ text }`, the document's
/// text with every non-HTML character blanked, or `null` when no project
/// lists the document. Implements [RAZOR-ARCHITECTURE-HTML].
pub fn handle_html_projection(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let params: HtmlProjectionParams = serde_json::from_value(req.params)?;
    let file = file_request(&params.text_document.uri)?;
    let request = (
        file.file_path,
        params.position.map(|at| (at.line, at.character)),
    );
    let projection: Option<(String,)> = fetch(runtime, sidecar, HTML_PROJECTION, &request)?;
    Ok(projection_answer(projection))
}

/// The wire answer for a sidecar projection: `{ text }`, or `null` for none.
fn projection_answer(projection: Option<(String,)>) -> serde_json::Value {
    projection.map_or(
        serde_json::Value::Null,
        |(text,)| serde_json::json!({ "text": text }),
    )
}

/// The sidecar request naming the document at `uri`.
fn file_request(uri: &Uri) -> Result<SidecarFileReq> {
    Ok(SidecarFileReq {
        file_path: crate::paths::uri_to_path(uri.as_str())?,
    })
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
    linked_ranges(&found)
}

/// The linked ranges of a sidecar answer, or `null` when it found none.
fn linked_ranges(found: &SidecarLocationListResult) -> Result<serde_json::Value> {
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

    /// A projection answers `{ text }`; a document no project lists answers
    /// `null`. [RAZOR-ARCHITECTURE-HTML]
    #[test]
    fn projections_answer_text_or_null() {
        assert_eq!(
            projection_answer(Some(("<p>   </p>".to_string(),))),
            serde_json::json!({ "text": "<p>   </p>" })
        );
        assert_eq!(projection_answer(None), serde_json::Value::Null);
    }

    /// Without the C# sidecar the projection request fails and names itself,
    /// rather than answering an empty projection.
    #[test]
    fn html_projection_without_sidecar_errors() {
        let req = Request::new(
            1.into(),
            HTML_PROJECTION.into(),
            serde_json::json!({ "textDocument": { "uri": "file:///a/Board.razor" } }),
        );
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let error = handle_html_projection(req, &runtime, None).expect_err("no sidecar");
        assert!(error.to_string().contains(HTML_PROJECTION), "{error}");
    }

    /// Without the C# sidecar the structure requests fail and name themselves,
    /// rather than answering that a file has no folds or linked tags.
    /// [RAZOR-FEATURES-STRUCTURE]
    #[test]
    fn structure_requests_without_sidecar_error() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        let board = serde_json::json!({ "uri": "file:///a/Board.razor" });
        let linked = Request::new(
            1.into(),
            "textDocument/linkedEditingRange".into(),
            serde_json::json!({ "textDocument": board, "position": { "line": 6, "character": 2 } }),
        );
        let error = handle_linked_editing_range(linked, &runtime, None).expect_err("no sidecar");
        assert!(error.to_string().contains("linkedEditingRange"), "{error}");

        let folds = Request::new(
            2.into(),
            "textDocument/foldingRange".into(),
            serde_json::json!({ "textDocument": board }),
        );
        let error = handle_folding_ranges(folds, &runtime, None).expect_err("no sidecar");
        assert!(error.to_string().contains("foldingRange"), "{error}");
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
