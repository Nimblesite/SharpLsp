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
use tracing::debug;

use crate::sidecar::manager::SidecarManager;
use crate::utils::{request_sidecar, with_sidecar, SidecarFileReq};

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
    with_sidecar(req, sidecar, |sidecar, params: SemanticTokensParams| {
        let file_path = crate::paths::uri_to_path(params.text_document.uri.as_str())?;
        let Some(data) = fetch_full_tokens(runtime, sidecar, file_path)? else {
            return Ok(serde_json::Value::Null);
        };
        debug!(values = data.len(), "semantic tokens from sidecar");
        let uri_str = params.text_document.uri.as_str();
        let result_id = TOKEN_CACHE
            .lock()
            .map(|mut cache| cache.store(uri_str, data.clone()))
            .ok();
        let mut tokens = decode_tokens(&data);
        tokens.result_id = result_id;
        Ok(serde_json::to_value(SemanticTokensResult::Tokens(tokens))?)
    })
}

/// Handle `textDocument/semanticTokens/range`.
pub fn handle_range(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: SemanticTokensRangeParams| {
            let request = SidecarRangeReq {
                file_path: crate::paths::uri_to_path(params.text_document.uri.as_str())?,
                start_line: params.range.start.line,
                start_character: params.range.start.character,
                end_line: params.range.end.line,
                end_character: params.range.end.character,
            };
            let method = "textDocument/semanticTokens/range";
            let Some(result) =
                request_sidecar::<SidecarSemanticTokens, _>(runtime, sidecar, method, &request)?
            else {
                return Ok(serde_json::Value::Null);
            };
            Ok(serde_json::to_value(SemanticTokensResult::Tokens(
                decode_tokens(&result.data),
            ))?)
        },
    )
}

/// Handle `textDocument/semanticTokens/full/delta`.
pub fn handle_delta(
    req: Request,
    runtime: &tokio::runtime::Runtime,
    sidecar: Option<&Arc<SidecarManager>>,
) -> Result<serde_json::Value> {
    with_sidecar(
        req,
        sidecar,
        |sidecar, params: lsp_types::SemanticTokensDeltaParams| {
            delta_against_cache(runtime, sidecar, &params)
        },
    )
}

/// Fresh tokens for the document, as edits against the client's previous result
/// when it is still cached, else in full.
fn delta_against_cache(
    runtime: &tokio::runtime::Runtime,
    sidecar: &SidecarManager,
    params: &lsp_types::SemanticTokensDeltaParams,
) -> Result<serde_json::Value> {
    let uri_str = params.text_document.uri.as_str();
    let prev_id = &params.previous_result_id;

    // Fetch fresh tokens from sidecar.
    let file_path = crate::paths::uri_to_path(params.text_document.uri.as_str())?;
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
    sidecar: &SidecarManager,
    file_path: String,
) -> Result<Option<Vec<i32>>> {
    let method = "textDocument/semanticTokens/full";
    let result: Option<SidecarSemanticTokens> =
        request_sidecar(runtime, sidecar, method, &SidecarFileReq { file_path })?;
    Ok(result.map(|tokens| tokens.data))
}

/// Integers per token on the wire: `[deltaLine, deltaStart, length, tokenType,
/// tokenModifiers]`.
const TOKEN_FIELDS: usize = 5;

/// Compute semantic token edits between old and new flat i32 arrays.
///
/// Implements [SHARPLSP-FEATURES-HIGHLIGHTING] "Delta semantic tokens".
///
/// The diff is taken over whole TOKENS, never over the flat integers. An edit's
/// `data` is a list of tokens, so an integer-granular range that began or ended
/// inside a token could only be sent by dropping the partial token — and that is
/// what left the client's array shorter than the server's cache, so that every
/// later delta landed outside it (#292). The matching suffix is clamped so it
/// never overlaps the matching prefix: without the clamp, appending a copy of
/// the last tokens looks like no change at all.
fn compute_delta(old: &[i32], new: &[i32]) -> Vec<SemanticTokensEdit> {
    let old_tokens = old.as_chunks::<TOKEN_FIELDS>().0;
    let new_tokens = new.as_chunks::<TOKEN_FIELDS>().0;
    let prefix = old_tokens
        .iter()
        .zip(new_tokens)
        .take_while(|(a, b)| a == b)
        .count();
    let unmatched = old_tokens
        .len()
        .min(new_tokens.len())
        .saturating_sub(prefix);
    let suffix = old_tokens
        .iter()
        .rev()
        .zip(new_tokens.iter().rev())
        .take_while(|(a, b)| a == b)
        .count()
        .min(unmatched);
    let deleted = old_tokens
        .len()
        .saturating_sub(prefix)
        .saturating_sub(suffix);
    let inserted: Vec<SemanticToken> = new_tokens
        .get(prefix..new_tokens.len().saturating_sub(suffix))
        .unwrap_or_default()
        .iter()
        .map(token_from_record)
        .collect();
    if deleted == 0 && inserted.is_empty() {
        return vec![];
    }
    vec![SemanticTokensEdit {
        start: wire_offset(prefix),
        delete_count: wire_offset(deleted),
        data: (!inserted.is_empty()).then_some(inserted),
    }]
}

/// The flat-array offset or count that `tokens` whole tokens occupy.
fn wire_offset(tokens: usize) -> u32 {
    u32::try_from(tokens.saturating_mul(TOKEN_FIELDS)).unwrap_or(u32::MAX)
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

/// Widen one LSP semantic-token field. A well-formed payload never carries a
/// negative value here, so a stray one is clamped to 0 rather than dropping the
/// whole token and desynchronising every delta that follows it.
fn token_field(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

/// Decode one flat five-field record into an LSP `SemanticToken`.
///
/// The wire format is `[deltaLine, deltaStart, length, tokenType,
/// tokenModifiers]` per token; taking the record as a fixed-size array is what
/// makes every field access infallible without indexing.
fn token_from_record(record: &[i32; TOKEN_FIELDS]) -> SemanticToken {
    let [delta_line, delta_start, length, token_type, modifiers] = *record;
    SemanticToken {
        delta_line: token_field(delta_line),
        delta_start: token_field(delta_start),
        length: token_field(length),
        token_type: token_field(token_type),
        token_modifiers_bitset: token_field(modifiers),
    }
}

/// Decode a flat i32 array into LSP `SemanticTokens`.
fn decode_tokens(data: &[i32]) -> SemanticTokens {
    let tokens: Vec<SemanticToken> = data
        .as_chunks::<TOKEN_FIELDS>()
        .0
        .iter()
        .map(token_from_record)
        .collect();
    SemanticTokens {
        result_id: None,
        data: tokens,
    }
}

// ── Wire types ────────────────────────────────────────────────────

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
        assert_eq!(inserted.first().unwrap().length, 4);
    }

    #[test]
    fn compute_delta_for_a_removed_token_deletes_without_inserting() {
        let old = [0, 0, 1, 0, 0];
        let new: [i32; 0] = [];

        let edits = compute_delta(&old, &new);

        let edit = edits.first().unwrap();
        assert_eq!(edit.start, 0);
        assert_eq!(edit.delete_count, 5, "the whole token is deleted");
        assert!(
            edit.data.is_none(),
            "a pure deletion carries no insert data"
        );
    }

    #[test]
    fn compute_delta_for_an_appended_copy_of_the_last_token_inserts_it() {
        // The matching prefix and the matching suffix would overlap here; the
        // suffix must yield, or a real second token is reported as no change.
        let old = [1, 2, 3, 4, 5];
        let new = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];

        let edits = compute_delta(&old, &new);

        let edit = edits.first().unwrap();
        assert_eq!(edit.start, 5, "the insert lands after the existing token");
        assert_eq!(edit.delete_count, 0, "nothing is deleted");
        assert_eq!(
            edit.data.as_ref().unwrap().len(),
            1,
            "one token is inserted"
        );
    }

    #[test]
    fn compute_delta_replaces_a_token_whose_leading_fields_still_match() {
        // Only `length` changed: an integer-granular diff would begin inside the
        // token and have to drop it, sending a deletion with no replacement.
        let old = [0, 0, 1, 0, 0];
        let new = [0, 0, 2, 0, 0];

        let edits = compute_delta(&old, &new);

        let edit = edits.first().unwrap();
        assert_eq!(edit.start, 0, "the edit starts on the token boundary");
        assert_eq!(edit.delete_count, 5, "the whole old token is deleted");
        let inserted = edit.data.as_ref().unwrap();
        assert_eq!(inserted.len(), 1, "and the whole new token replaces it");
        assert_eq!(inserted.first().unwrap().length, 2);
    }

    /// Replay `edits` over `old` exactly as an LSP client does.
    fn apply(old: &[i32], edits: &[SemanticTokensEdit]) -> Vec<i32> {
        let mut data = old.to_vec();
        for edit in edits.iter().rev() {
            let start = usize::try_from(edit.start).unwrap();
            let end = start + usize::try_from(edit.delete_count).unwrap();
            let inserted: Vec<i32> = edit.data.iter().flatten().flat_map(record_of).collect();
            let _replaced: Vec<i32> = data.splice(start..end, inserted).collect();
        }
        data
    }

    /// The five wire integers of one decoded token.
    fn record_of(token: &SemanticToken) -> [i32; TOKEN_FIELDS] {
        [
            token.delta_line,
            token.delta_start,
            token.length,
            token.token_type,
            token.token_modifiers_bitset,
        ]
        .map(|field| i32::try_from(field).unwrap())
    }

    #[test]
    fn compute_delta_edits_replay_to_exactly_the_new_array() {
        let a = [0, 0, 1, 0, 0];
        let b = [0, 2, 3, 1, 0];
        let c = [1, 0, 4, 2, 0];
        let d = [0, 5, 6, 3, 1];
        let cases: [(Vec<i32>, Vec<i32>); 6] = [
            ([a, b, c].concat(), [d, a, b, c].concat()),
            ([a, b, c].concat(), [a, d, b, c].concat()),
            ([a, b, c].concat(), [a, d, c].concat()),
            ([a, b, c].concat(), [a, c].concat()),
            ([a, b, c].concat(), [a].concat()),
            ([a, b, c, d].concat(), [a, b, c, d, c, d].concat()),
        ];
        for (old, new) in &cases {
            let edits = compute_delta(old, new);
            assert_eq!(
                &apply(old, &edits),
                new,
                "old={old:?} new={new:?} edits={edits:?}"
            );
        }
    }
}
