//! Semantic tokens handlers (`textDocument/semanticTokens/full`, `/range`, `/full/delta`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::Result;
use lsp_server::Request;
use lsp_types::{
    SemanticToken, SemanticTokens, SemanticTokensDelta, SemanticTokensEdit,
    SemanticTokensFullDeltaResult, SemanticTokensParams, SemanticTokensRangeParams,
    SemanticTokensResult,
};
use tracing::{debug, warn};

use crate::sidecar::manager::SidecarManager;

/// Cache of previous semantic token results per document URI.
static TOKEN_CACHE: std::sync::LazyLock<Mutex<TokenCache>> =
    std::sync::LazyLock::new(|| Mutex::new(TokenCache::new()));

/// Per-document cache of previously computed semantic tokens for delta support.
struct TokenCache {
    /// Map from document URI to its cached token data.
    entries: HashMap<String, CachedTokens>,
    /// Monotonically increasing ID for result versioning.
    next_id: u64,
}

/// Cached semantic token data for a single document.
struct CachedTokens {
    /// Unique result ID returned to the client.
    result_id: String,
    /// Flat i32 array of encoded semantic tokens.
    data: Vec<i32>,
}

impl TokenCache {
    /// Create an empty token cache.
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            next_id: 0,
        }
    }

    /// Store token data for a document and return the new result ID.
    fn store(&mut self, uri: &str, data: Vec<i32>) -> String {
        self.next_id += 1;
        let result_id = self.next_id.to_string();
        drop(self.entries.insert(
            uri.to_string(),
            CachedTokens {
                result_id: result_id.clone(),
                data,
            },
        ));
        result_id
    }

    /// Retrieve cached token data if the result ID matches.
    fn get(&self, uri: &str, result_id: &str) -> Option<&[i32]> {
        self.entries
            .get(uri)
            .filter(|e| e.result_id == result_id)
            .map(|e| e.data.as_slice())
    }
}

/// Handle `textDocument/semanticTokens/full`.
pub fn handle_full(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: SemanticTokensParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let Some(data) = fetch_full_tokens(runtime, sidecar, file_path)? else {
        return Ok(serde_json::Value::Null);
    };
    debug!("Got {} semantic token values from sidecar", data.len());
    let uri_str = params.text_document.uri.as_str();
    let result_id = TOKEN_CACHE
        .lock()
        .map(|mut cache| cache.store(uri_str, data.clone()))
        .ok();
    let mut tokens = decode_tokens(&data);
    tokens.result_id = result_id;
    Ok(serde_json::to_value(SemanticTokensResult::Tokens(tokens))?)
}

/// Handle `textDocument/semanticTokens/range`.
pub fn handle_range(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: SemanticTokensRangeParams = serde_json::from_value(req.params)?;
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;

    let request = SidecarRangeReq {
        file_path,
        start_line: params.range.start.line,
        start_character: params.range.start.character,
        end_line: params.range.end.line,
        end_character: params.range.end.character,
    };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/semanticTokens/range", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar semanticTokens/range unavailable: {err:#}");
                return Ok(serde_json::Value::Null);
            }
        };

    let result: SidecarSemanticTokens = rmp_serde::from_slice(&response_bytes)?;
    Ok(serde_json::to_value(SemanticTokensResult::Tokens(
        decode_tokens(&result.data),
    ))?)
}

/// Handle `textDocument/semanticTokens/full/delta`.
pub fn handle_delta(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    let Some(sidecar) = sidecar else {
        return Ok(serde_json::Value::Null);
    };
    let params: lsp_types::SemanticTokensDeltaParams = serde_json::from_value(req.params)?;
    let uri_str = params.text_document.uri.as_str();
    let prev_id = &params.previous_result_id;

    // Fetch fresh tokens from sidecar.
    let file_path = crate::semantic::uri_to_path(&params.text_document.uri)?;
    let Some(new_data) = fetch_full_tokens(runtime, sidecar, file_path)? else {
        return Ok(serde_json::Value::Null);
    };

    // Try to compute delta against cached previous result.
    let delta = TOKEN_CACHE.lock().ok().and_then(|cache| {
        let old_data = cache.get(uri_str, prev_id)?;
        Some(compute_delta(old_data, &new_data))
    });

    // Cache the new tokens.
    let new_result_id = TOKEN_CACHE
        .lock()
        .map(|mut cache| cache.store(uri_str, new_data.clone()))
        .ok();

    if let Some(edits) = delta {
        Ok(serde_json::to_value(
            SemanticTokensFullDeltaResult::TokensDelta(SemanticTokensDelta {
                result_id: new_result_id,
                edits,
            }),
        )?)
    } else {
        let mut tokens = decode_tokens(&new_data);
        tokens.result_id = new_result_id;
        Ok(serde_json::to_value(
            SemanticTokensFullDeltaResult::Tokens(tokens),
        )?)
    }
}

/// Fetch the full flat token array for `file_path` from the sidecar.
///
/// Returns `Ok(None)` when the sidecar is unavailable so callers can reply with
/// `null`, mirroring the LSP "no result" response.
fn fetch_full_tokens(
    runtime: &tokio::runtime::Runtime,
    sidecar: &Arc<SidecarManager>,
    file_path: String,
) -> Result<Option<Vec<i32>>> {
    let request = SidecarFileReq { file_path };
    let payload = rmp_serde::to_vec(&request)?;
    let response_bytes =
        match runtime.block_on(sidecar.request("textDocument/semanticTokens/full", payload)) {
            Ok(bytes) => bytes,
            Err(err) => {
                warn!("Sidecar semanticTokens/full unavailable: {err:#}");
                return Ok(None);
            }
        };
    let result: SidecarSemanticTokens = rmp_serde::from_slice(&response_bytes)?;
    Ok(Some(result.data))
}

/// Compute semantic token edits between old and new flat i32 arrays.
fn compute_delta(old: &[i32], new: &[i32]) -> Vec<SemanticTokensEdit> {
    if old == new {
        return vec![];
    }
    // Find first differing position.
    let prefix_len = old
        .iter()
        .zip(new.iter())
        .take_while(|(a, b)| a == b)
        .count();
    // Find last differing position from the end.
    let suffix_len = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let old_changed_end = old.len().saturating_sub(suffix_len);
    let new_changed_end = new.len().saturating_sub(suffix_len);

    if prefix_len >= old_changed_end && prefix_len >= new_changed_end {
        return vec![];
    }

    let delete_count = old_changed_end.saturating_sub(prefix_len);
    let insert_data: Vec<SemanticToken> = new
        .get(prefix_len..new_changed_end)
        .unwrap_or_default()
        .chunks_exact(5)
        .filter_map(|c| {
            Some(SemanticToken {
                delta_line: u32::try_from(*c.first()?).unwrap_or(0),
                delta_start: u32::try_from(*c.get(1)?).unwrap_or(0),
                length: u32::try_from(*c.get(2)?).unwrap_or(0),
                token_type: u32::try_from(*c.get(3)?).unwrap_or(0),
                token_modifiers_bitset: u32::try_from(*c.get(4)?).unwrap_or(0),
            })
        })
        .collect();

    vec![SemanticTokensEdit {
        start: u32::try_from(prefix_len).unwrap_or(0),
        delete_count: u32::try_from(delete_count).unwrap_or(0),
        data: if insert_data.is_empty() {
            None
        } else {
            Some(insert_data)
        },
    }]
}

/// Token type legend — must match the sidecar's `SemanticTokensResolver.TokenTypes`.
pub fn token_types() -> Vec<lsp_types::SemanticTokenType> {
    vec![
        lsp_types::SemanticTokenType::NAMESPACE,
        lsp_types::SemanticTokenType::TYPE,
        lsp_types::SemanticTokenType::CLASS,
        lsp_types::SemanticTokenType::ENUM,
        lsp_types::SemanticTokenType::INTERFACE,
        lsp_types::SemanticTokenType::STRUCT,
        lsp_types::SemanticTokenType::TYPE_PARAMETER,
        lsp_types::SemanticTokenType::PARAMETER,
        lsp_types::SemanticTokenType::VARIABLE,
        lsp_types::SemanticTokenType::PROPERTY,
        lsp_types::SemanticTokenType::ENUM_MEMBER,
        lsp_types::SemanticTokenType::EVENT,
        lsp_types::SemanticTokenType::FUNCTION,
        lsp_types::SemanticTokenType::METHOD,
        lsp_types::SemanticTokenType::MACRO,
        lsp_types::SemanticTokenType::KEYWORD,
        lsp_types::SemanticTokenType::MODIFIER,
        lsp_types::SemanticTokenType::COMMENT,
        lsp_types::SemanticTokenType::STRING,
        lsp_types::SemanticTokenType::NUMBER,
        lsp_types::SemanticTokenType::REGEXP,
        lsp_types::SemanticTokenType::OPERATOR,
        lsp_types::SemanticTokenType::DECORATOR,
    ]
}

/// Token modifier legend.
pub fn token_modifiers() -> Vec<lsp_types::SemanticTokenModifier> {
    vec![
        lsp_types::SemanticTokenModifier::DECLARATION,
        lsp_types::SemanticTokenModifier::DEFINITION,
        lsp_types::SemanticTokenModifier::READONLY,
        lsp_types::SemanticTokenModifier::STATIC,
        lsp_types::SemanticTokenModifier::DEPRECATED,
        lsp_types::SemanticTokenModifier::ABSTRACT,
        lsp_types::SemanticTokenModifier::ASYNC,
    ]
}

/// Decode a flat i32 array into LSP `SemanticTokens`.
fn decode_tokens(data: &[i32]) -> SemanticTokens {
    let tokens: Vec<SemanticToken> = data
        .chunks_exact(5)
        .filter_map(|chunk| {
            Some(SemanticToken {
                delta_line: u32::try_from(*chunk.first()?).unwrap_or(0),
                delta_start: u32::try_from(*chunk.get(1)?).unwrap_or(0),
                length: u32::try_from(*chunk.get(2)?).unwrap_or(0),
                token_type: u32::try_from(*chunk.get(3)?).unwrap_or(0),
                token_modifiers_bitset: u32::try_from(*chunk.get(4)?).unwrap_or(0),
            })
        })
        .collect();
    SemanticTokens {
        result_id: None,
        data: tokens,
    }
}

// ── Wire types ────────────────────────────────────────────────────

/// Sidecar request identifying a document by file path.
#[derive(serde::Serialize)]
struct SidecarFileReq {
    /// Absolute filesystem path of the document.
    file_path: String,
}

/// Sidecar request for semantic tokens within a specific range.
#[derive(serde::Serialize)]
struct SidecarRangeReq {
    /// Absolute filesystem path of the document.
    file_path: String,
    /// Start line of the requested range.
    start_line: u32,
    /// Start character of the requested range.
    start_character: u32,
    /// End line of the requested range.
    end_line: u32,
    /// End character of the requested range.
    end_character: u32,
}

/// Sidecar response containing a flat array of encoded semantic tokens.
#[derive(serde::Deserialize)]
struct SidecarSemanticTokens {
    /// Flat i32 array: groups of 5 (deltaLine, deltaStart, length, tokenType, modifiers).
    data: Vec<i32>,
}

#[cfg(test)]
#[expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]
mod tests {
    use super::*;

    #[test]
    fn compute_delta_of_identical_arrays_is_empty() {
        let tokens = [0, 0, 1, 0, 0, 1, 0, 2, 0, 0];
        assert!(compute_delta(&tokens, &tokens).is_empty());
    }

    #[test]
    fn compute_delta_for_an_appended_token_inserts_without_deleting() {
        let old = [0, 0, 1, 0, 0];
        // The appended token shares no suffix with `old`, so the whole token is
        // a clean insertion at the end.
        let new = [0, 0, 1, 0, 0, 2, 3, 4, 5, 6];

        let edits = compute_delta(&old, &new);

        let edit = edits.first().unwrap();
        assert_eq!(edit.delete_count, 0, "appending deletes nothing");
        let inserted = edit.data.as_ref().unwrap();
        assert_eq!(inserted.len(), 1, "exactly one new token is inserted");
        assert_eq!(inserted[0].length, 4);
    }

    #[test]
    fn compute_delta_for_a_removed_token_deletes_without_inserting() {
        let old = [0, 0, 1, 0, 0];
        let new: [i32; 0] = [];

        let edits = compute_delta(&old, &new);

        let edit = edits.first().unwrap();
        assert_eq!(edit.start, 0);
        assert_eq!(edit.delete_count, 5, "the whole token is deleted");
        assert!(edit.data.is_none(), "a pure deletion carries no insert data");
    }

    #[test]
    fn compute_delta_when_change_is_absorbed_by_prefix_and_suffix_is_empty() {
        // The new array merely duplicates the old: the matching prefix and suffix
        // overlap so there is no net change to emit.
        let old = [1, 2, 3, 4, 5];
        let new = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];

        assert!(compute_delta(&old, &new).is_empty());
    }
}
