//! `sharplsp/relatedFiles` — the files that belong with the one being edited:
//! a form and its designer, a view and its code-behind, a component and its
//! stylesheet, an implementation and its signature file. They are the files
//! beside it that share its name up to the first dot, so no list of extensions
//! has to keep up with the SDKs. [SHARPLSP-FEATURES-NAVIGATION-RELATED]

use std::path::Path;

use anyhow::Result;
use lsp_server::Request;
use lsp_types::TextDocumentIdentifier;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::info;

use crate::paths;

/// Request params for `sharplsp/relatedFiles`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelatedFilesParams {
    /// The document whose related files are wanted.
    text_document: TextDocumentIdentifier,
}

/// One related file.
#[derive(Debug, Serialize)]
struct RelatedFile {
    /// The file's URI.
    uri: String,
    /// The file's name, for a picker.
    name: String,
}

/// Response for `sharplsp/relatedFiles`.
#[derive(Debug, Serialize)]
struct RelatedFilesResponse {
    /// The related files, sorted by path; empty when the file stands alone.
    files: Vec<RelatedFile>,
}

/// Handle `sharplsp/relatedFiles`.
pub fn handle(req: Request) -> Result<Value> {
    let params: RelatedFilesParams = serde_json::from_value(req.params)?;
    let path = paths::uri_to_path(params.text_document.uri.as_str())?;
    let files: Vec<RelatedFile> = paths::family_siblings(Path::new(&path))
        .iter()
        .filter_map(|sibling| related(sibling))
        .collect();
    info!(method = "sharplsp/relatedFiles", uri = %params.text_document.uri.as_str(), count = files.len(), "related files listed");
    Ok(serde_json::to_value(RelatedFilesResponse { files })?)
}

/// The wire entry of one sibling; a path with no URI or UTF-8 name is left out.
fn related(sibling: &Path) -> Option<RelatedFile> {
    Some(RelatedFile {
        uri: paths::native_path_to_uri(sibling).ok()?,
        name: paths::file_name_of(sibling)?.to_string(),
    })
}
