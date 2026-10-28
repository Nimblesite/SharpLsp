//! The background warm-up never holds up the user. [SHARPLSP-FEATURES-WARM-UP]
use super::*;

/// Before the client asks anything, the warm-up of the opened workspace reads
/// the held source: the compiler really checks the project in the background.
/// A hover asked while that read is held is answered at once, from the user's
/// own text, and once the source is released the same compiler reports the
/// user's current error.
#[test]
fn a_hover_during_the_held_warm_up_answers_at_once() {
    let fixture = fixture::Fixture::fsharp();
    let barrier = held::Barrier::new(&fixture);
    let mut session = session::Session::new(&fixture);
    let compiler = session.compiler();

    // 1. No request has reached the compiler, so only the warm-up reads the source.
    barrier.wait(compiler);

    // 2. The user opens the file and hovers while the warm-up's read is held.
    session.open(2, fixture::CURRENT_FS);
    let hover = session.hover_value();
    assert!(
        hover.contains("value") && hover.contains("int"),
        "the hover describes `value: int`: {hover}"
    );
    assert!(
        barrier.is_held(),
        "the hover waited for the warm-up's held read"
    );
    session.assert_compiler(compiler);

    // 3. Released, the same compiler reports the user's current error.
    barrier.release();
    let _current = session.pull(Some("FS0039"), None);
    session.assert_compiler(compiler);
    session.shut_down();
}
