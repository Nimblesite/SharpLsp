//! A respawned compiler restores the workspace it had only while that
//! workspace still exists. [DIAG-TRUTH-RECOVERY]
use std::sync::atomic::Ordering;

use anyhow::Result;

use crate::sidecar::fake_compiler::{answering, empty, Fake};

/// Answer one request as a freshly respawned compiler does; the workspaces it replayed.
fn respawn(runtime: &tokio::runtime::Runtime, fake: &Fake) -> Result<Vec<String>> {
    fake.manager.session.pending.store(true, Ordering::Release);
    let mark = fake.mark()?;
    let method = "workspace/diagnostics/documents";
    let _documents = runtime.block_on(fake.manager.request(method, rmp_serde::to_vec(&())?))?;
    fake.opened(mark)
}

/// A scratch solution that a scaffold or a test deletes stays remembered as the
/// selected workspace. Its restore can never succeed, and each failed restore
/// respawned the compiler again: on Windows CI the F# compiler respawned 99
/// times in two minutes and answered nothing.
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
fn a_respawn_replays_the_remembered_workspace_only_while_it_exists() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let fake = Fake::connect(&runtime, answering(empty()));
    let root = tempfile::tempdir()?;
    let scratch = root.path().join("Scratch.slnx");
    std::fs::write(&scratch, "<Solution />")?;
    let target = scratch.to_string_lossy().into_owned();
    let open = rmp_serde::to_vec(&target)?;
    let _opened = runtime.block_on(fake.manager.request("workspace/open", open))?;

    let restored = respawn(&runtime, &fake)?;
    assert_eq!(
        restored,
        std::slice::from_ref(&target),
        "a respawn restores the workspace it had"
    );
    std::fs::remove_file(&scratch)?;
    let deleted = respawn(&runtime, &fake)?;
    assert!(
        deleted.is_empty(),
        "a deleted workspace is never replayed: {deleted:?}"
    );
    std::fs::write(&scratch, "<Solution />")?;
    let returned = respawn(&runtime, &fake)?;
    assert_eq!(returned, [target], "and is restored again once it is back");
    Ok(())
}
