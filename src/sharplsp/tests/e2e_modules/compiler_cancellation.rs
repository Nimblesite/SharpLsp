//! Actual SDK/compiler cancellation, never a replacement diagnostic backend.
//! Implements [DIAG-ANALYSIS-CANCELLATION] and [DIAG-TRUTH-GUARANTEES].
use super::*;

mod assertions;
mod held;
mod inputs;
mod interests;
mod selections;
mod warm_up;

#[test]
fn cancelled_fsharp_read_does_not_delay_current_diagnostics_until_old_io_finishes() {
    assert_fsharp_cancellation("textDocument/diagnostic");
}

#[test]
fn cancelled_fsharp_code_lens_does_not_block_current_diagnostics_or_lose_reference_counts() {
    assert_fsharp_cancellation("textDocument/codeLens");
}

#[test]
fn fresh_pull_supersedes_held_fsharp_work_without_client_cancellation() {
    run_fsharp("textDocument/diagnostic", fresh_fsharp_while_held);
}

type FSharpInterruption = fn(&mut session::Session<'_>, &held::Barrier, i32, &str) -> String;

/// The same real held compiler read must be cancellable for both editor requests.
fn assert_fsharp_cancellation(method: &str) {
    run_fsharp(method, current_fsharp_while_held);
}

/// Every interruption retains the same compiler, SDK truth and complete terminal assertions.
fn run_fsharp(method: &str, interruption: FSharpInterruption) {
    run_fsharp_request(interruption, |session, _| session.begin_request(method));
}

/// Actual prior identities and workspace requests retain every shared lifecycle assertion.
fn run_fsharp_request(
    interruption: impl FnOnce(&mut session::Session<'_>, &held::Barrier, i32, &str) -> String,
    begin: impl FnOnce(&mut session::Session<'_>, &str) -> i32,
) {
    let fixture = fixture::Fixture::fsharp();
    let original = first_fsharp_report(&fixture);
    let mut owned = None;
    let barrier = held::Barrier::new(&fixture);
    let session = owned.insert(session::Session::new(&fixture));
    let compiler = session.compiler();
    let pending = begin(session, &original);
    barrier.wait(compiler);
    let current = interruption(session, &barrier, pending, &original);
    session.assert_compiler(compiler);
    barrier.release();
    let clean = session.change(3, fixture::CLEAN_FS, None, &current);
    session.assert_references(&clean);
    session.close(&clean, "FS0001");
    session.assert_compiler(compiler);
    owned.take().expect("owned F# session").finish(pending);
}

/// The first session independently proves saved compiler truth and exits before setup.
fn first_fsharp_report(fixture: &fixture::Fixture) -> String {
    let mut warm = session::Session::new(fixture);
    warm.open(100, fixture.saved());
    let id = warm.pull(Some("FS0001"), None);
    warm.stop();
    id
}

/// Releasing old I/O or restarting the compiler cannot rescue a successful current pull.
fn current_fsharp_while_held(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    session.cancel_pending(pending);
    session.open(2, fixture::CURRENT_FS);
    let current = session.pull(Some("FS0039"), Some(previous));
    assert!(
        barrier.is_held(),
        "fresh diagnostics waited for obsolete compiler I/O"
    );
    current
}

/// [DIAG-ANALYSIS-CANCELLATION]: a new pull replaces interest without $/cancelRequest.
fn fresh_fsharp_while_held(
    session: &mut session::Session<'_>,
    barrier: &held::Barrier,
    pending: i32,
    previous: &str,
) -> String {
    session.open(2, fixture::CURRENT_FS);
    let fresh = session.begin_fresh_pull(previous);
    session.assert_superseded(pending);
    assert!(
        barrier.is_held(),
        "superseding a diagnostic pull waited for obsolete compiler I/O"
    );
    let current = session.current_pull(fresh, previous);
    assert!(
        barrier.is_held(),
        "fresh pull waited for obsolete compiler I/O"
    );
    current
}
mod fixture;
mod session;

#[test]
fn cancelled_real_roslyn_analyzer_releases_current_errors_without_a_compiler_restart() {
    run_csharp(|session, compiler, original| {
        let cancelled = session.cancel_analyzer(compiler);
        let edited = session.change(3, fixture::CURRENT_CS, Some("CS0029"), original);
        (cancelled, edited)
    });
}

/// Actual SDK truth, token ownership, repairs and close are shared by every Roslyn case.
fn run_csharp(
    interruption: impl FnOnce(&mut session::Session<'_>, sysinfo::Pid, &str) -> (i32, String),
) {
    let fixture = fixture::Fixture::csharp();
    let mut session = session::Session::new(&fixture);
    let _release = fixture.release_guard();
    let original = session.pull(Some("CS0103"), None);
    let compiler = session.compiler();
    let (cancelled, edited) = interruption(&mut session, compiler, &original);
    session.assert_compiler(compiler);
    let clean = session.change(4, fixture::CLEAN_CS, None, &edited);
    session.close(&clean, "CS0103");
    session.assert_compiler(compiler);
    session.finish(cancelled);
}
