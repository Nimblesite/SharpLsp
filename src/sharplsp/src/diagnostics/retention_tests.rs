//! What the push gate keeps after a document closes. [DIAG-PUSH-GATE]
#![expect(
    clippy::unwrap_used,
    reason = "test code — panics are the correct failure mode"
)]

use super::*;

/// Documents a long session opens, edits and closes.
const DOCUMENTS: usize = 300;

/// A placeholder set: the tier-1 restore has not finished yet.
fn placeholder() -> Vec<Diagnostic> {
    vec![Diagnostic {
        code: Some(NumberOrString::String(RESTORE_PENDING_CODE.to_string())),
        message: "restoring".to_string(),
        ..Diagnostic::default()
    }]
}

/// Whether either push-gate map still holds `uri`.
fn retained(uri: &Uri) -> (bool, bool) {
    let key = uri.as_str();
    (
        PUSH_GENERATIONS.iter().any(|entry| entry.key() == key),
        PROVISIONAL_PUBLISHED.iter().any(|entry| entry.key() == key),
    )
}

/// Memory leak: every document ever pushed kept a generation counter and a
/// provisional flag for the host's life, so each file opened, renamed or
/// left behind by a solution switch stayed resident after it closed.
#[test]
fn closed_documents_leave_nothing_in_the_push_gate() {
    let (sender, receiver) = crossbeam_channel::unbounded();
    let uris: Vec<Uri> = (0..DOCUMENTS)
        .map(|n| {
            format!("file:///tmp/slsp-retention/Doc{n}.cs")
                .parse()
                .unwrap()
        })
        .collect();

    for uri in &uris {
        let generation = next_generation(uri);
        assert!(publish_if_current(&sender, uri, generation, placeholder()).unwrap());
        assert!(
            published_set_is_provisional(uri),
            "an open placeholder set is provisional"
        );
        clear(&sender, uri.clone()).unwrap();
        assert!(
            !published_set_is_provisional(uri),
            "a cleared document has nothing provisional"
        );
        assert!(
            !is_current(uri, generation),
            "a fetch begun before the close must never publish"
        );
    }

    let kept: Vec<&Uri> = uris
        .iter()
        .filter(|uri| retained(uri) != (false, false))
        .collect();
    assert!(
        kept.is_empty(),
        "{} of {DOCUMENTS} closed documents are still held, first {:?}",
        kept.len(),
        kept.first().map(|uri| (uri.as_str(), retained(uri)))
    );
    assert_eq!(
        receiver.len(),
        DOCUMENTS * 2,
        "each push and clear published"
    );
}

/// Forgetting a closed document must not let a fetch begun before the close
/// match the reopened document's first generation and publish stale results.
#[test]
fn a_reopened_document_never_reuses_a_closed_generation() {
    let (sender, _receiver) = crossbeam_channel::unbounded();
    let uri: Uri = "file:///tmp/slsp-retention/Reopened.cs".parse().unwrap();

    let before_close = next_generation(&uri);
    clear(&sender, uri.clone()).unwrap();
    let reopened = next_generation(&uri);

    assert_ne!(reopened, before_close, "generations are never reused");
    assert!(is_current(&uri, reopened), "the reopened push is current");
    assert!(
        !publish_if_current(&sender, &uri, before_close, placeholder()).unwrap(),
        "the pre-close fetch is superseded"
    );
    assert!(
        !published_set_is_provisional(&uri),
        "nothing stale published"
    );
}
