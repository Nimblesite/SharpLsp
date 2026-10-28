//! A respawned compiler restores the workspace it had only while that
//! workspace still exists, and every open buffer it still loads.
//! [DIAG-TRUTH-RECOVERY]
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::paths;
use crate::sidecar::fake_compiler::{answering, empty, Fake, Fault, Faults};
use crate::tree_sitter_parse::LangId;
use crate::vfs::Vfs;

/// The open C# buffers every replay test holds.
const BUFFERS: [&str; 3] = ["First.cs", "Middle.cs", "Last.cs"];

/// A compiler that answers `fault` to the replay of each buffer in `faulted`.
fn faulting(faulted: Vec<String>, fault: fn(&str) -> Fault) -> Faults {
    Arc::new(move |method, payload| {
        let (path, _text) = rmp_serde::from_slice::<(String, String)>(payload).ok()?;
        (method == "textDocument/didChange" && faulted.contains(&path)).then(|| fault(&path))
    })
}

/// The C# compiler refuses a buffer it does not load, as Roslyn does.
fn not_found(path: &str) -> Fault {
    Fault::Refuse(format!("Document not found: {path}"))
}

/// A compiler holding [`BUFFERS`] open, faulting the replay of those at `faulted`;
/// the manager, its buffers' paths, and the store that keeps them open.
fn holding_buffers(
    runtime: &tokio::runtime::Runtime,
    dir: &std::path::Path,
    faulted: &[usize],
    fault: fn(&str) -> Fault,
) -> Result<(Fake, Vec<String>, Arc<Vfs>)> {
    let buffers: Vec<String> = BUFFERS
        .iter()
        .map(|name| dir.join(name).to_string_lossy().into_owned())
        .collect();
    let picked = faulted
        .iter()
        .filter_map(|&index| buffers.get(index).cloned());
    let faults = faulting(picked.collect(), fault);
    let fake = Fake::connect_faulting(runtime, LangId::CSharp, answering(empty()), faults);
    let vfs = Arc::new(Vfs::new());
    for buffer in &buffers {
        vfs.open(paths::path_to_lsp_uri(buffer)?, 1, "class C {}".to_owned());
    }
    fake.manager.set_document_source(&vfs);
    Ok((fake, buffers, vfs))
}

/// After a respawn the compiler refuses the buffers at `refused`: the restore
/// still finishes, every buffer was offered once, and nothing replays again.
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
fn restores_past(refused: &[usize]) -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let dir = tempfile::tempdir()?;
    let (fake, mut buffers, _open) = holding_buffers(&runtime, dir.path(), refused, not_found)?;
    let mark = fake.mark()?;
    let _restored = respawn(&runtime, &fake)
        .with_context(|| format!("a refusal of {refused:?} still restores"))?;
    let mut offered = fake.replayed(mark)?;
    offered.sort();
    buffers.sort();
    assert_eq!(
        offered, buffers,
        "every open buffer is offered exactly once"
    );
    let settled = fake.mark()?;
    let method = "workspace/diagnostics/documents";
    let _documents = runtime.block_on(fake.manager.request(method, rmp_serde::to_vec(&())?))?;
    assert!(
        fake.replayed(settled)?.is_empty(),
        "a finished restore is never repeated"
    );
    Ok(())
}

/// The baseline: a compiler that loads every buffer.
#[test]
fn a_respawn_replays_every_open_buffer() -> Result<()> {
    restores_past(&[])
}

/// A buffer in a folder deleted since it was opened, such as a scratch file a
/// finished test left open, is one the restored compiler cannot load. Its
/// refusal failed the restore, which respawned the compiler and replayed the
/// same buffer again: on Windows CI the C# compiler respawned 64 times and
/// every later request timed out.
#[test]
fn a_respawn_skips_the_first_buffer_the_compiler_refuses() -> Result<()> {
    restores_past(&[0])
}

#[test]
fn a_respawn_skips_a_middle_buffer_the_compiler_refuses() -> Result<()> {
    restores_past(&[1])
}

#[test]
fn a_respawn_skips_the_last_buffer_the_compiler_refuses() -> Result<()> {
    restores_past(&[2])
}

#[test]
fn a_respawn_skips_every_buffer_the_compiler_refuses() -> Result<()> {
    restores_past(&[0, 1, 2])
}

/// Only a refusal is skipped: a compiler that dies mid-replay leaves no
/// usable session, so the restore still fails and the session is dropped.
#[test]
#[expect(
    clippy::panic_in_result_fn,
    reason = "test assertions intentionally fail while Result carries fixture I/O errors"
)]
fn a_compiler_that_dies_mid_replay_still_fails_the_restore() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    let dir = tempfile::tempdir()?;
    let (fake, _buffers, _open) = holding_buffers(&runtime, dir.path(), &[1], |_| Fault::HangUp)?;
    let Err(failed) = respawn(&runtime, &fake) else {
        anyhow::bail!("a dead compiler is never a restored session");
    };
    assert!(
        format!("{failed:#}").contains("restore compiler workspace inputs"),
        "the restore itself fails: {failed:#}"
    );
    Ok(())
}

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
