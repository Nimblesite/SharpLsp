//! A code lens never holds up the user. A cold lens counts references across
//! every project, and the compiler answers one request at a time, so a hover
//! asked behind it waited for the whole count (#504). An interactive request
//! preempts the lens in flight; a lens nothing interrupts completes; and the
//! host's own polling never preempts one. [SHARPLSP-FEATURES-CODE-LENS]
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use lspkit_server::CancellationToken;
use lspkit_sidecar::cancellation::RequestCancelled;
use tokio::sync::mpsc::UnboundedReceiver;

use super::SidecarManager;
use crate::sidecar::protocol::Envelope;
use crate::sidecar::transport::FramedTransport;

/// Long enough for a preemption to cross the in-memory stream many times over.
const PROMPTLY: Duration = Duration::from_secs(5);
/// How long a request that must NOT preempt is given to do so anyway.
const QUIET: Duration = Duration::from_millis(300);

/// The compiler's side of the stream: requests, and the notices beside them.
struct Compiler {
    /// Requests, read in the order the host wrote them.
    transport: FramedTransport,
    /// Notices such as `$/cancelRequest`, which carry no request identity.
    notices: UnboundedReceiver<Envelope>,
}

impl Compiler {
    /// The next request the compiler reads, within [`PROMPTLY`].
    async fn request(&mut self, waiting_for: &str) -> Result<Envelope> {
        tokio::time::timeout(PROMPTLY, self.transport.read_envelope())
            .await
            .with_context(|| format!("timed out waiting for {waiting_for}"))??
            .with_context(|| format!("the host closed the stream before {waiting_for}"))
    }

    /// The next notice the compiler receives, within [`PROMPTLY`].
    async fn notice(&mut self, waiting_for: &str) -> Result<Envelope> {
        tokio::time::timeout(PROMPTLY, self.notices.recv())
            .await
            .with_context(|| format!("timed out waiting for {waiting_for}"))?
            .with_context(|| format!("the host closed the stream before {waiting_for}"))
    }

    /// Answer `request` with `payload`.
    async fn answer(&mut self, request: &Envelope, payload: &[u8]) -> Result<()> {
        let response = Envelope {
            id: request.id,
            method: None,
            payload: payload.to_vec(),
            error: None,
        };
        self.transport.write_envelope(&response).await
    }
}

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

/// `method`, asked without a cancellation of its own.
fn ask(
    manager: &Arc<SidecarManager>,
    method: &'static str,
) -> tokio::task::JoinHandle<Result<Vec<u8>>> {
    let manager = Arc::clone(manager);
    tokio::spawn(async move { manager.request(method, Vec::new()).await })
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
    let hover = ask(manager, "textDocument/hover");
    let cancel = compiler.notice("the hover to preempt the lens").await?;
    assert_eq!(
        cancel.method.as_deref(),
        Some("$/cancelRequest"),
        "it cancels before it waits"
    );
    let cancelled: u32 = rmp_serde::from_slice(&cancel.payload)?;
    assert_eq!(
        Some(cancelled),
        lens_request.id,
        "exactly the lens in flight"
    );
    compiler.answer(&lens_request, b"").await?;
    let hovering = compiler.request("the hover").await?;
    assert_eq!(hovering.method.as_deref(), Some("textDocument/hover"));
    compiler.answer(&hovering, b"hover").await?;
    assert_eq!(hover.await??, b"hover", "the hover is answered");
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
    let poll = ask(manager, "workspace/diagnostics/documents");
    let quiet = tokio::time::timeout(QUIET, compiler.notices.recv()).await;
    assert!(quiet.is_err(), "polling never cancels a lens");
    compiler.answer(&lens_request, b"lenses").await?;
    assert_eq!(polled.await??, b"lenses", "the lens completes");
    let polling = compiler.request("the poll").await?;
    assert_eq!(
        polling.method.as_deref(),
        Some("workspace/diagnostics/documents")
    );
    compiler.answer(&polling, b"polled").await?;
    assert_eq!(
        poll.await??,
        b"polled",
        "and the poll is answered in its turn"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interactive_request_preempts_the_code_lens_in_flight() -> Result<()> {
    let (host, stream) = tokio::io::duplex(64 * 1024);
    let manager = Arc::new(SidecarManager::connected_to_stream_for_tests(host).await);
    let mut transport = FramedTransport::from_stream(stream);
    let notices = transport
        .take_notifications()
        .context("the notice channel")?;
    let mut compiler = Compiler { transport, notices };
    let client = CancellationToken::new();
    let held = a_hover_preempts_the_lens(&manager, &mut compiler, &client).await?;
    assert_preempted(held, &client).await?;
    an_uninterrupted_lens_completes(&manager, &mut compiler, &client).await?;
    polling_never_preempts(&manager, &mut compiler, &client).await
}
