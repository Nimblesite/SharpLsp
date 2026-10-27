//! Real compiler scope and competing protocol frames. [DIAG-ANALYSIS-CANCELLATION]
use super::*;

#[test]
fn equal_previous_result_interest_preserves_the_older_pull() {
    run_fsharp("textDocument/diagnostic", repeated);
}

#[test]
fn another_compiled_file_cannot_supersede_the_held_pull() {
    run_fsharp("textDocument/diagnostic", unrelated);
}

#[test]
fn client_cancellation_before_fresh_interest_keeps_the_client_error() {
    run_fsharp("textDocument/diagnostic", client_first);
}

#[test]
fn fresh_interest_before_client_cancellation_keeps_the_supersession_error() {
    run_fsharp("textDocument/diagnostic", supersession_first);
}

fn repeated(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    session.cancel_pending(pending);
    let first = session.begin_fresh_pull(previous);
    let repeated = session.begin_fresh_pull(previous);
    session.assert_pending(first);
    session.cancel_pending(repeated);
    current_fsharp_while_held(session, barrier, first, previous)
}

fn unrelated(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    let other = session.begin_other_pull(previous);
    session.assert_pending(pending);
    session.cancel_pending(other);
    current_fsharp_while_held(session, barrier, pending, previous)
}

fn client_first(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    session.request_cancel(pending);
    let replacing = session.begin_fresh_pull(previous);
    session.cancel_pending(replacing);
    current_fsharp_while_held(session, barrier, pending, previous)
}

fn supersession_first(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    let replacing = session.begin_fresh_pull(previous);
    session.request_cancel(pending);
    session.assert_superseded(pending);
    current_fsharp_while_held(session, barrier, replacing, previous)
}
