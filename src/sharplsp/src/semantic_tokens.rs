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
use crate::utils::{request_sidecar, with_sidecar, SidecarFileReq, SidecarRangeReq};

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
        let Some(data) = fetch_full_tokens(runtime, sidecar, &params.text_document.uri)? else {
            return Ok(serde_json::Value::Null);
        };
        debug!(values = data.len(), "semantic tokens from sidecar");
        let result_id = remember_tokens(params.text_document.uri.as_str(), &data);
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
            let request = SidecarRangeReq::at(&params.text_document.uri, params.range)?;
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

    let Some(new_data) = fetch_full_tokens(runtime, sidecar, &params.text_document.uri)? else {
        return Ok(serde_json::Value::Null);
    };

    // Try to compute delta against cached previous result.
    let delta = TOKEN_CACHE.lock().ok().and_then(|cache| {
        let old_data = cache.get(uri_str, prev_id)?;
        Some(compute_delta(old_data, &new_data))
    });

    let new_result_id = remember_tokens(uri_str, &new_data);

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
    uri: &lsp_types::Uri,
) -> Result<Option<Vec<i32>>> {
    let method = "textDocument/semanticTokens/full";
    let request = SidecarFileReq {
        file_path: crate::paths::uri_to_path(uri.as_str())?,
    };
    let result: Option<SidecarSemanticTokens> =
        request_sidecar(runtime, sidecar, method, &request)?;
    Ok(result.map(|tokens| tokens.data))
}

/// Cache `data` as the document's latest result and return the id the client
/// will quote in its next delta request; `None` when the cache lock is poisoned.
fn remember_tokens(uri: &str, data: &[i32]) -> Option<String> {
    TOKEN_CACHE
        .lock()
        .map(|mut cache| cache.store(uri, data.to_vec()))
        .ok()
}

/// Drop a closed document's cached tokens; reopening it starts from a full
/// result, so nothing a client can still quote is lost.
pub fn forget(uri: &str) {
    if let Ok(mut cache) = TOKEN_CACHE.lock() {
        let _ = cache.entries.remove(uri);
    }
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
        // [SHARPLSP-FEATURES-HIGHLIGHTING] "Keyword classes": `if`, `for`, `return`.
        lsp_types::SemanticTokenType::new("controlKeyword"),
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

/// Sidecar response containing a flat array of encoded semantic tokens.
#[derive(serde::Deserialize)]
struct SidecarSemanticTokens {
    /// Flat i32 array: groups of 5 (deltaLine, deltaStart, length, tokenType, modifiers).
    data: Vec<i32>,
}

#[cfg(test)]
#[path = "semantic_tokens_tests.rs"]
mod tests;
