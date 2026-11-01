//! A code lens never holds up the user. A cold lens counts references across
//! every project, and the compiler answers one request at a time, so a hover
//! asked behind it waited for the whole count (#504). An interactive request
//! preempts the lens in flight; a lens nothing interrupts completes; and the
//! host's own polling never preempts one. [SHARPLSP-FEATURES-CODE-LENS]
use std::sync::Arc;

use anyhow::{Context, Result};
use lspkit::sidecar::cancellation::RequestCancelled;
use lspkit_server::CancellationToken;

use super::test_compiler::{polling_waits, preempts, Compiler};
use super::SidecarManager;
use crate::sidecar::protocol::Envelope;

/// A code lens asked for by `client`, as the code lens handler asks for one.
fn lens(
    manager: &Arc<SidecarManager>,
    client: &CancellationToken,
) -> tokio::task::JoinHandle<Result<Vec<u8>>> {
    let manager = Arc::clone(manager);
    let client = client.clone();
    tokio::spawn(async move {
        manager
            .request_cancellable("textDocument/codeLens", Vec::new(), Some(&client))
            .await
    })
}

/// A lens the compiler is counting when `asked` arrives; its result, and the request.
async fn counting(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    client: &CancellationToken,
) -> Result<(tokio::task::JoinHandle<Result<Vec<u8>>>, Envelope)> {
    let held = lens(manager, client);
    let request = compiler.request("the code lens").await?;
    Ok((held, request))
}

/// 1. A cold lens is still counting references when the user hovers: the hover
///    cancels exactly that lens before it waits, and is answered.
async fn a_hover_preempts_the_lens(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    client: &CancellationToken,
) -> Result<tokio::task::JoinHandle<Result<Vec<u8>>>> {
    let (held, lens_request) = counting(manager, compiler, client).await?;
    preempts(manager, compiler, "textDocument/hover", &lens_request).await?;
    Ok(held)
}

/// The preempted lens reads as cancelled, never as an empty success.
async fn assert_preempted(
    held: tokio::task::JoinHandle<Result<Vec<u8>>>,
    client: &CancellationToken,
) -> Result<()> {
    let preempted = held
        .await?
        .err()
        .context("a preempted lens is never an empty success")?;
    assert!(
        preempted.is::<RequestCancelled>(),
        "it reads as cancelled: {preempted:#}"
    );
    assert!(!client.is_cancelled(), "by the hover, not by its client");
    Ok(())
}

/// 2. The lens asked again, with nothing interrupting it, completes.
async fn an_uninterrupted_lens_completes(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    client: &CancellationToken,
) -> Result<()> {
    let (again, lens_request) = counting(manager, compiler, client).await?;
    compiler.answer(&lens_request, b"lenses").await?;
    assert_eq!(again.await??, b"lenses", "an uninterrupted lens completes");
    Ok(())
}

/// 3. The host's own diagnostics polling waits its turn instead.
async fn polling_never_preempts(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    client: &CancellationToken,
) -> Result<()> {
    let (polled, lens_request) = counting(manager, compiler, client).await?;
    polling_waits(manager, compiler, &lens_request, b"lenses").await?;
    assert_eq!(polled.await??, b"lenses", "the lens completes");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interactive_request_preempts_the_code_lens_in_flight() -> Result<()> {
    let (manager, mut compiler) = Compiler::attach(None).await?;
    let client = CancellationToken::new();
    let held = a_hover_preempts_the_lens(&manager, &mut compiler, &client).await?;
    assert_preempted(held, &client).await?;
    an_uninterrupted_lens_completes(&manager, &mut compiler, &client).await?;
    polling_never_preempts(&manager, &mut compiler, &client).await
}
