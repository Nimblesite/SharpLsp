//! Input versions supersede blocked compiler work. [DIAG-ANALYSIS-CANCELLATION]
use super::*;

#[test]
fn same_previous_result_input_change_releases_the_held_document_pull() {
    run_fsharp_request(fresh_fsharp_while_held, |session, previous| {
        session.begin_fresh_pull(previous)
    });
}

#[test]
fn workspace_input_change_releases_held_analysis_before_current_errors() {
    run_fsharp_request(fresh_fsharp_while_held, |session, _| {
        session.begin_workspace()
    });
}

#[test]
fn code_lens_input_change_releases_held_analysis_before_current_errors() {
    run_fsharp("textDocument/codeLens", fresh_fsharp_while_held);
}

#[test]
fn roslyn_change_cancels_actual_analyzer_work_before_another_pull() {
    run_csharp(roslyn_change);
}

#[test]
fn roslyn_close_cancels_actual_analyzer_work_and_restores_saved_errors() {
    run_csharp(roslyn_close);
}

#[test]
fn unrelated_input_keeps_the_active_analyzer_request_until_client_cancellation() {
    run_csharp(unrelated_input);
}

fn unrelated_input(
    session: &mut session::Session<'_>,
    compiler: sysinfo::Pid,
    previous: &str,
) -> (i32, String) {
    let pending = session.begin_analyzer(compiler, Some(previous));
    session.open_other(1);
    session.request_cancel(pending);
    session.analyzer_cancelled_by_client(compiler, pending);
    let edited = session.change(3, fixture::CURRENT_CS, Some("CS0029"), previous);
    (pending, edited)
}

fn roslyn_change(
    session: &mut session::Session<'_>,
    compiler: sysinfo::Pid,
    previous: &str,
) -> (i32, String) {
    let pending = session.begin_analyzer(compiler, Some(previous));
    session.notify_change(3, fixture::CURRENT_CS);
    session.analyzer_superseded(compiler, pending);
    let edited = session.pull(Some("CS0029"), Some(previous));
    (pending, edited)
}

fn roslyn_close(
    session: &mut session::Session<'_>,
    compiler: sysinfo::Pid,
    previous: &str,
) -> (i32, String) {
    let pending = session.begin_analyzer(compiler, Some(previous));
    session.notify_close();
    session.analyzer_superseded(compiler, pending);
    let saved = session.pull(Some("CS0103"), Some(previous));
    session.open(3, fixture::CURRENT_CS);
    let edited = session.pull(Some("CS0029"), Some(&saved));
    (pending, edited)
}
