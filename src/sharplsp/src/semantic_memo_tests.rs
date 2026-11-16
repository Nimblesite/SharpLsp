//! The semantic memo answers a repeat without the compiler and asks again
//! whenever an input moved. [DEFINITION-CACHE] [REFERENCES-SALSA] [HOVER-CACHING]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::{Key, Memo};

/// A question at `line` of one document under `method`.
fn key(method: &'static str, line: u32) -> Key {
    Key {
        uri: "file:///memo/Program.cs".to_owned(),
        method,
        line,
        character: 3,
    }
}

/// Ask `memo`, counting compiler round trips in `asked`.
fn ask(
    memo: &Memo,
    key: &Key,
    version: i32,
    asked: &Arc<AtomicUsize>,
    value: Value,
    settled: bool,
) -> (Value, bool) {
    let counter = Arc::clone(asked);
    memo.answer(
        key,
        version,
        Box::new(move || {
            let _ = counter.fetch_add(1, Ordering::SeqCst);
            Ok((value, settled))
        }),
    )
    .unwrap_or((Value::Null, false))
}

#[test]
fn a_repeat_is_answered_by_the_memo_until_an_input_moves() {
    let (memo, asked) = (Memo::default(), Arc::new(AtomicUsize::new(0)));
    let definition = key("textDocument/definition", 2);
    let first = ask(&memo, &definition, 1, &asked, json!({"line": 9}), true);
    assert_eq!(
        first,
        (json!({"line": 9}), false),
        "a miss asks the compiler"
    );
    let repeat = ask(&memo, &definition, 1, &asked, json!("unused"), true);
    assert_eq!(repeat, (json!({"line": 9}), true), "the repeat is a hit");
    assert_eq!(asked.load(Ordering::SeqCst), 1, "one round trip so far");

    // The same position under another method is another question.
    let hover = key("textDocument/hover", 2);
    let other = ask(&memo, &hover, 1, &asked, json!("hover"), true);
    assert_eq!(other, (json!("hover"), false));
    assert_eq!(asked.load(Ordering::SeqCst), 2);

    // A new document version asks again, and the new answer replaces the old.
    let edited = ask(&memo, &definition, 2, &asked, json!({"line": 10}), true);
    assert_eq!(edited, (json!({"line": 10}), false));
    let edited_repeat = ask(&memo, &definition, 2, &asked, json!("unused"), true);
    assert_eq!(edited_repeat, (json!({"line": 10}), true));
    assert_eq!(asked.load(Ordering::SeqCst), 3);

    // An edit anywhere else moves the generation: every answer is asked again.
    memo.invalidate();
    let after = ask(&memo, &definition, 2, &asked, json!({"line": 11}), true);
    assert_eq!(after, (json!({"line": 11}), false));
    let hover_after = ask(&memo, &hover, 1, &asked, json!("hover 2"), true);
    assert_eq!(hover_after, (json!("hover 2"), false));
    assert_eq!(asked.load(Ordering::SeqCst), 5);
}

#[test]
fn empty_unsettled_and_failed_answers_are_asked_again() {
    let (memo, asked) = (Memo::default(), Arc::new(AtomicUsize::new(0)));
    let references = key("textDocument/references:decl", 4);
    // [GitHub #110] An empty list may mean the workspace is still loading.
    for empty in [json!([]), Value::Null] {
        let answer = ask(&memo, &references, 1, &asked, empty.clone(), true);
        assert_eq!(answer, (empty, false));
    }
    assert_eq!(
        asked.load(Ordering::SeqCst),
        2,
        "empty answers are not kept"
    );

    // [DEFINITION-CROSSLANG-IDENTITY] An unsettled answer is returned, not kept.
    let unsettled = ask(&memo, &references, 1, &asked, json!(["decompiled"]), false);
    assert_eq!(unsettled, (json!(["decompiled"]), false));
    let settled = ask(&memo, &references, 1, &asked, json!(["source"]), true);
    assert_eq!(settled, (json!(["source"]), false), "asked again");
    let kept = ask(&memo, &references, 1, &asked, json!("unused"), true);
    assert_eq!(
        kept,
        (json!(["source"]), true),
        "the settled answer is kept"
    );
    assert_eq!(asked.load(Ordering::SeqCst), 4);

    // A failed round trip reaches the caller and is never replayed.
    let failing = key("textDocument/documentHighlight", 6);
    let failure = memo.answer(&failing, 1, Box::new(|| anyhow::bail!("bad params")));
    assert_eq!(
        failure.err().map(|error| error.to_string()),
        Some("bad params".to_owned())
    );
    let retried = ask(&memo, &failing, 1, &asked, json!([1]), true);
    assert_eq!(retried, (json!([1]), false), "the failure was not memoized");
}

#[test]
fn releasing_drops_every_answer_and_input() {
    let (memo, asked) = (Memo::default(), Arc::new(AtomicUsize::new(0)));
    let keys: Vec<Key> = (0..8).map(|line| key("textDocument/hover", line)).collect();
    for each in &keys {
        let _ = ask(&memo, each, 1, &asked, json!("hover"), true);
    }
    assert_eq!(memo.state().questions.len(), 8);
    let before = memo.generation();
    memo.release();
    assert_eq!(memo.state().questions.len(), 0, "closing releases inputs");
    assert!(memo.generation() > before, "and moves the generation");
    let again = ask(
        &memo,
        &key("textDocument/hover", 0),
        1,
        &asked,
        json!("fresh"),
        true,
    );
    assert_eq!(again, (json!("fresh"), false), "nothing survives a release");
    assert_eq!(asked.load(Ordering::SeqCst), 9);
}

#[test]
fn the_question_table_is_bounded() {
    let (memo, asked) = (Memo::default(), Arc::new(AtomicUsize::new(0)));
    for line in 0..u32::try_from(super::QUESTION_LIMIT).unwrap_or(u32::MAX) {
        let _ = ask(
            &memo,
            &key("textDocument/hover", line),
            1,
            &asked,
            json!("h"),
            true,
        );
    }
    assert_eq!(memo.state().questions.len(), super::QUESTION_LIMIT);
    let _ = ask(
        &memo,
        &key("textDocument/hover", 1),
        1,
        &asked,
        json!("h"),
        true,
    );
    assert_eq!(memo.state().questions.len(), 1, "the table was replaced");
}

#[test]
fn a_memo_hit_answers_in_under_a_millisecond() {
    // [DEFINITION-PERFORMANCE] [REFERENCES-PERFORMANCE] A realistic answer:
    // five hundred reference locations, asked a thousand times.
    let (memo, asked) = (Memo::default(), Arc::new(AtomicUsize::new(0)));
    let locations: Vec<Value> = (0..500)
        .map(|line| json!({"uri": "file:///memo/Program.cs", "range": {"start": {"line": line, "character": 4}, "end": {"line": line, "character": 12}}}))
        .collect();
    let references = key("textDocument/references:decl", 7);
    let first = ask(&memo, &references, 1, &asked, Value::Array(locations), true);
    assert!(!first.1, "the first question asks the compiler");
    let mut times: Vec<std::time::Duration> = (0..1000)
        .map(|_| {
            let started = std::time::Instant::now();
            let repeat = ask(&memo, &references, 1, &asked, Value::Null, true);
            let elapsed = started.elapsed();
            assert!(repeat.1, "every repeat is a hit");
            assert_eq!(repeat.0.as_array().map(Vec::len), Some(500));
            elapsed
        })
        .collect();
    times.sort();
    let median = times
        .get(times.len().midpoint(0))
        .copied()
        .unwrap_or_default();
    assert!(
        median < std::time::Duration::from_millis(1),
        "a memo hit took {median:?}"
    );
    assert_eq!(asked.load(Ordering::SeqCst), 1, "one compiler round trip");
}
