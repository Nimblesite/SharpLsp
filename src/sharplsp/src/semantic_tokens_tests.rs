//! Semantic token cache and delta tests.

#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use super::*;

/// Whether the delta cache still holds tokens for `uri`.
fn cached(uri: &str) -> bool {
    TOKEN_CACHE.lock().unwrap().entries.contains_key(uri)
}

/// Memory leak: every document whose tokens were ever requested kept its
/// whole token array for the life of the host, open or not. Closing a
/// document must drop its cached tokens; a later delta request for it
/// starts from a full result anyway. [SHARPLSP-FEATURES-HIGHLIGHTING]
#[test]
#[expect(
    clippy::mutable_key_type,
    reason = "lsp_types::Uri Hash/Eq use string repr only"
)]
fn closing_a_document_releases_its_cached_semantic_tokens() {
    let closing = "file:///leak/Closing.cs";
    let staying = "file:///leak/Staying.cs";
    let closing_id = remember_tokens(closing, &[0, 0, 5, 1, 0, 1, 2, 3, 0, 0]).unwrap();
    let staying_id = remember_tokens(staying, &[0, 0, 7, 2, 0]).unwrap();
    assert!(
        cached(closing),
        "tokens are cached while the document is open"
    );
    assert_ne!(closing_id, staying_id, "each result gets its own id");

    let (server, _client) = lsp_server::Connection::memory();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let vfs = crate::vfs::Vfs::new();
    let parsers = crate::tree_sitter_parse::TsParsers::new();
    let mut trees = std::collections::HashMap::new();
    let mut nav_cache = crate::nav_cache::NavCache::new();
    let close = lsp_server::Notification::new(
        "textDocument/didClose".to_string(),
        serde_json::json!({ "textDocument": { "uri": closing } }),
    );
    crate::notifications::handle(
        close,
        &mut crate::notifications::DocumentContext {
            vfs: &vfs,
            parsers: &parsers,
            trees: &mut trees,
            nav_cache: &mut nav_cache,
            connection: &server,
            runtime: &runtime,
            sidecars: [None, None],
        },
    );

    assert!(!cached(closing), "a closed document's tokens are released");
    assert!(cached(staying), "other documents keep their delta baseline");
    let cache = TOKEN_CACHE.lock().unwrap();
    assert_eq!(
        cache.get(staying, &staying_id),
        Some([0, 0, 7, 2, 0].as_slice())
    );
}

#[test]
fn compute_delta_of_identical_arrays_is_empty() {
    let tokens = [0, 0, 1, 0, 0, 1, 0, 2, 0, 0];
    assert!(
        matches!(compute_delta(&tokens, &tokens).as_slice(), []),
        "{:?}",
        compute_delta(&tokens, &tokens)
    );
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
