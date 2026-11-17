//! `textDocument/hover` through the language sidecar, memoized per document
//! version and position. [HOVER-ROUTING] [HOVER-CACHING]

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{Hover, HoverContents, HoverParams, MarkupContent, MarkupKind, Position, Range};
use tracing::{info, warn};

use super::navigation::memoized;
use super::Route;
use crate::utils::{request_sidecar, SidecarPositionReq};
use crate::vfs::Vfs;

/// The LSP method this module answers and memoizes under.
const METHOD: &str = "textDocument/hover";

/// Handle `textDocument/hover` via the language sidecar, memoized. [HOVER-CACHING]
pub fn handle_hover(req: Request, vfs: &Vfs, route: Route) -> Result<serde_json::Value> {
    if route.primary.is_none() {
        warn!("Hover: no sidecar available");
        return Ok(serde_json::Value::Null);
    }
    memoized(req, vfs, METHOD, move |req| {
        ask(req, &route).map(|value| (value, true))
    })
}

/// The sidecar's hover at the request's position; `null` when it has none or
/// could not answer.
fn ask(req: Request, route: &Route) -> Result<serde_json::Value> {
    let Some(sidecar) = route.primary.as_ref() else {
        return Ok(serde_json::Value::Null);
    };
    let params: HoverParams = serde_json::from_value(req.params)?;
    let uri = params.text_document_position_params.text_document.uri;
    let at = params.text_document_position_params.position;
    info!(
        file = uri.as_str(),
        line = at.line,
        character = at.character,
        "Hover request dispatching to sidecar"
    );
    let request = SidecarPositionReq::at(&uri, at)?;
    let Some(answer) = request_sidecar::<Option<SidecarHoverResult>, _>(
        route.caller(),
        sidecar,
        METHOD,
        &request,
    )?
    else {
        return Ok(serde_json::Value::Null);
    };
    info!(
        file = uri.as_str(),
        found = answer.is_some(),
        "Hover: sidecar answered"
    );
    Ok(serde_json::to_value(answer.map(to_hover))?)
}

/// The LSP hover for a sidecar answer: markdown contents plus the symbol range when known.
fn to_hover(result: SidecarHoverResult) -> Hover {
    Hover {
        range: hover_range(&result),
        contents: HoverContents::Markup(MarkupContent {
            kind: MarkupKind::Markdown,
            value: result.contents,
        }),
    }
}

/// Build an LSP `Range` from optional sidecar hover coordinates.
fn hover_range(result: &SidecarHoverResult) -> Option<Range> {
    match (
        result.start_line,
        result.start_character,
        result.end_line,
        result.end_character,
    ) {
        (Some(sl), Some(sc), Some(el), Some(ec)) => {
            Some(Range::new(Position::new(sl, sc), Position::new(el, ec)))
        }
        _ => None,
    }
}

/// Sidecar hover response with optional range coordinates.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SidecarHoverResult {
    /// Markdown-formatted hover content.
    contents: String,
    /// Optional start line of the hovered symbol.
    start_line: Option<u32>,
    /// Optional start character of the hovered symbol.
    start_character: Option<u32>,
    /// Optional end line of the hovered symbol.
    end_line: Option<u32>,
    /// Optional end character of the hovered symbol.
    end_character: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hover_range_needs_all_four_coordinates() {
        let full = SidecarHoverResult {
            contents: "x".into(),
            start_line: Some(1),
            start_character: Some(2),
            end_line: Some(1),
            end_character: Some(5),
        };
        assert_eq!(
            hover_range(&full),
            Some(Range::new(Position::new(1, 2), Position::new(1, 5)))
        );
        let partial = SidecarHoverResult {
            end_character: None,
            ..full
        };
        assert_eq!(hover_range(&partial), None);
        assert_eq!(hover_range(&SidecarHoverResult::default()), None);
    }
}
