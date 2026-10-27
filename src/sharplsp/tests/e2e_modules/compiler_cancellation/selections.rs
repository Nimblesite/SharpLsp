//! Workspace replacement cannot wait on old compiler I/O. [DIAG-ANALYSIS-CANCELLATION]
use super::*;

#[test]
fn solution_selection_replaces_held_document_work_and_retires_old_errors() {
    switching("textDocument/diagnostic");
}

#[test]
fn solution_selection_replaces_held_workspace_scan_and_retires_old_errors() {
    switching("workspace/diagnostic");
}

#[test]
fn solution_selection_replaces_held_code_lens_and_retires_old_errors() {
    switching("textDocument/codeLens");
}

fn switching(method: &str) {
    let next = fixture::Fixture::fsharp();
    std::fs::write(&next.source, fixture::CURRENT_FS).expect("new selected source");
    workspace_diagnostic_support::assert_build(&next.solution, Some("FS0039"));
    run_fsharp_request(
        |session, barrier, pending, previous| {
            transition(session, barrier, pending, previous, &next)
        },
        |session, _| {
            if method == "workspace/diagnostic" {
                session.begin_workspace()
            } else {
                session.begin_request(method)
            }
        },
    );
}

fn transition(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
    next: &fixture::Fixture,
) -> String {
    session.select(next);
    session.assert_superseded(pending);
    assert!(
        barrier.is_held(),
        "solution selection waited for obsolete compiler I/O"
    );
    let _current = session.selected_pull(next, "FS0039", previous);
    let selected = session.selected_scope(next, "FS0039", previous);
    session.select_original();
    session.open(2, fixture::CURRENT_FS);
    let _current = session.pull(Some("FS0039"), Some(&selected));
    let current = session.original_scope(next, "FS0039", &selected);
    assert!(
        barrier.is_held(),
        "switchback waited for old I/O or restarted the compiler"
    );
    current
}
