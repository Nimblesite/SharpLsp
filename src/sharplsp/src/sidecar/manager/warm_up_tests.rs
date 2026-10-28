//! The F# compiler warms every project after a workspace opens, one request
//! per project. An interactive request preempts the warm-up like any
//! background work, and the walk retries that same project after a pause; a
//! newer open starts the walk again from the first project; and a compiler
//! that is not F#'s never warms. [SHARPLSP-FEATURES-WARM-UP]
use std::sync::Arc;

use anyhow::{ensure, Result};

use super::test_compiler::{polling_waits, preempts, Compiler};
use super::warm_up::WARM_UP;
use super::SidecarManager;
use crate::sidecar::protocol::Envelope;
use crate::tree_sitter_parse::LangId;

/// `language`'s compiler, whose manager runs the warm-up, after one open.
async fn opened(language: LangId) -> Result<(Arc<SidecarManager>, Compiler)> {
    let (manager, compiler) = Compiler::attach(Some(language)).await?;
    drop(tokio::spawn(Arc::clone(&manager).start_warm_up()));
    manager.workspace_opened();
    Ok((manager, compiler))
}

/// The warm-up's next request, which must be for project `index`.
async fn expect_warm(compiler: &mut Compiler, index: usize) -> Result<Envelope> {
    let request = compiler
        .request(&format!("the warm-up of project {index}"))
        .await?;
    assert_eq!(
        request.method.as_deref(),
        Some(WARM_UP),
        "a warm-up request"
    );
    assert_eq!(
        rmp_serde::from_slice::<usize>(&request.payload)?,
        index,
        "for project {index}"
    );
    Ok(request)
}

/// Answer a warm-up request: the compiler holds `total` projects.
async fn warmed(compiler: &mut Compiler, request: &Envelope, total: usize) -> Result<()> {
    compiler.answer(request, &rmp_serde::to_vec(&total)?).await
}

/// The warm-up of project `index`, answered: the compiler holds `total`.
async fn warms(compiler: &mut Compiler, index: usize, total: usize) -> Result<()> {
    let request = expect_warm(compiler, index).await?;
    warmed(compiler, &request, total).await
}

/// The walk's last warm-up, after which it asks nothing more.
async fn finishes(compiler: &mut Compiler, index: usize, total: usize) -> Result<()> {
    warms(compiler, index, total).await?;
    ensure!(
        compiler.stays_quiet().await,
        "a warm workspace asks nothing more"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_opened_workspace_warms_each_project_and_a_hover_preempts_the_walk() -> Result<()> {
    let (manager, mut compiler) = opened(LangId::FSharp).await?;

    // 1. The walk warms project 0 of the three the compiler holds.
    warms(&mut compiler, 0, 3).await?;

    // 2. A hover preempts project 1's warm-up; the walk then retries project 1.
    let second = expect_warm(&mut compiler, 1).await?;
    preempts(&manager, &mut compiler, "textDocument/hover", &second).await?;
    warms(&mut compiler, 1, 3).await?;

    // 3. Project 2 completes the walk, and nothing more is asked.
    finishes(&mut compiler, 2, 3).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_open_restarts_the_walk_and_other_compilers_never_warm() -> Result<()> {
    // 1. An open while project 0 warms abandons the walk for the newer one.
    let (manager, mut compiler) = opened(LangId::FSharp).await?;
    let first = expect_warm(&mut compiler, 0).await?;
    manager.workspace_opened();
    warmed(&mut compiler, &first, 2).await?;

    // 2. The newer walk starts again from project 0, its only project.
    finishes(&mut compiler, 0, 1).await?;

    // 3. The C# compiler never warms.
    let (_csharp, mut roslyn) = opened(LangId::CSharp).await?;
    ensure!(roslyn.stays_quiet().await, "only the F# compiler warms");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_diagnostic_pull_preempts_the_warm_up_and_the_hosts_polling_never_does() -> Result<()> {
    let (manager, mut compiler) = opened(LangId::FSharp).await?;

    // 1. The host's own polling waits its turn behind project 0's warm-up.
    let first = expect_warm(&mut compiler, 0).await?;
    polling_waits(
        &manager,
        &mut compiler,
        &first,
        &rmp_serde::to_vec(&2_usize)?,
    )
    .await?;

    // 2. A diagnostics pull preempts project 1's warm-up and is answered.
    let second = expect_warm(&mut compiler, 1).await?;
    preempts(&manager, &mut compiler, "workspace/diagnostics", &second).await?;

    // 3. The walk retries project 1 and completes.
    finishes(&mut compiler, 1, 2).await
}
