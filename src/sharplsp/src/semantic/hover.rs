//! `textDocument/hover` through the language sidecar, cached per document
//! version and position. [HOVER-ROUTING]

use std::sync::Arc;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{Hover, HoverContents, HoverParams, MarkupContent, MarkupKind, Position, Range};
use tracing::{info, warn};

use crate::nav_cache::NavCache;
use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, SidecarPositionReq};
use crate::vfs::Vfs;

/// The LSP method this module answers and caches under.
const METHOD: &str = "textDocument/hover";

/// Handle `textDocument/hover` via the language sidecar, with caching.
pub fn handle_hover(
    req: Request,
    vfs: &Vfs,
    nav_cache: &mut NavCache,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        warn!("Hover: no sidecar available");
        return Ok(serde_json::Value::Null);
    };
    let params: HoverParams = serde_json::from_value(req.params)?;
    let uri = params.text_document_position_params.text_document.uri;
    let at = params.text_document_position_params.position;
    let version = vfs.get_version(&uri).unwrap_or(0);
    if let Some(cached) = nav_cache.get(uri.as_str(), version, at.line, at.character, METHOD) {
        info!("Hover cache hit");
        return Ok(cached.clone());
    }
    info!(
        file = uri.as_str(),
        line = at.line,
        character = at.character,
        "Hover request dispatching to sidecar"
    );
    let request = SidecarPositionReq::at(&uri, at)?;
    // A sidecar that could not answer leaves the cache alone; its "no hover" is cached.
    let Some(answer) =
        request_sidecar::<Option<SidecarHoverResult>, _>(runtime, sidecar, METHOD, &request)?
    else {
        return Ok(serde_json::Value::Null);
    };
    info!(
        file = uri.as_str(),
        found = answer.is_some(),
        "Hover: sidecar answered"
    );
    let value = serde_json::to_value(answer.map(to_hover))?;
    nav_cache.insert(
        uri.as_str(),
        version,
        at.line,
        at.character,
        METHOD,
        value.clone(),
    );
    Ok(value)
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
