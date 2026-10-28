//! The compiler's side of an in-memory stream, driven by hand: the tests read
//! what the host asks, see the notices beside it, and answer when they choose.
use std::sync::Arc;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use tokio::sync::mpsc::UnboundedReceiver;

use super::SidecarManager;
use crate::sidecar::protocol::Envelope;
use crate::sidecar::transport::FramedTransport;
use crate::tree_sitter_parse::LangId;

/// Long enough for a request or notice to cross the in-memory stream many times over.
const PROMPTLY: Duration = Duration::from_secs(5);
/// How long the host is given to send something it must NOT send.
const QUIET: Duration = Duration::from_millis(300);
/// The host's own diagnostics polling, which no request waits on.
const POLL: &str = "workspace/diagnostics/documents";

/// `method` asked of `manager` without a cancellation of its own.
fn ask(
    manager: &Arc<SidecarManager>,
    method: &'static str,
) -> tokio::task::JoinHandle<Result<Vec<u8>>> {
    let manager = Arc::clone(manager);
    tokio::spawn(async move { manager.request(method, Vec::new()).await })
}

/// `method`, asked while the compiler works on `background`, cancels exactly
/// that request before it waits its turn, and is answered once the compiler
/// answers the cancelled request.
pub(super) async fn preempts(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    method: &'static str,
    background: &Envelope,
) -> Result<()> {
    let asked = ask(manager, method);
    compiler.cancels(background).await?;
    compiler.answer(background, b"").await?;
    compiler.serve(method, method.as_bytes()).await?;
    ensure!(asked.await?? == method.as_bytes(), "{method} is answered");
    Ok(())
}

/// The host's own polling, asked while the compiler works on `background`,
/// never cancels it: the poll waits until `background` is answered with
/// `reply`, then is answered in its turn.
pub(super) async fn polling_waits(
    manager: &Arc<SidecarManager>,
    compiler: &mut Compiler,
    background: &Envelope,
    reply: &[u8],
) -> Result<()> {
    let poll = ask(manager, POLL);
    ensure!(
        compiler.hears_no_notice().await,
        "polling never cancels background work"
    );
    compiler.answer(background, reply).await?;
    compiler.serve(POLL, b"polled").await?;
    ensure!(
        poll.await?? == b"polled",
        "the poll is answered in its turn"
    );
    Ok(())
}

/// The compiler's side of the stream: requests, and the notices beside them.
pub(super) struct Compiler {
    /// Requests, read in the order the host wrote them.
    transport: FramedTransport,
    /// Notices such as `$/cancelRequest`, which carry no request identity.
    notices: UnboundedReceiver<Envelope>,
}

impl Compiler {
    /// A manager wired to a hand-driven compiler, as `language`'s compiler when given.
    pub(super) async fn attach(language: Option<LangId>) -> Result<(Arc<SidecarManager>, Self)> {
        let (host, stream) = tokio::io::duplex(64 * 1024);
        let manager = match language {
            Some(language) => SidecarManager::compiler_on_stream_for_tests(host, language).await,
            None => SidecarManager::connected_to_stream_for_tests(host).await,
        };
        let mut transport = FramedTransport::from_stream(stream);
        let notices = transport
            .take_notifications()
            .context("the notice channel")?;
        Ok((Arc::new(manager), Self { transport, notices }))
    }

    /// The next request the compiler reads, within [`PROMPTLY`].
    pub(super) async fn request(&mut self, waiting_for: &str) -> Result<Envelope> {
        tokio::time::timeout(PROMPTLY, self.transport.read_envelope())
            .await
            .with_context(|| format!("timed out waiting for {waiting_for}"))??
            .with_context(|| format!("the host closed the stream before {waiting_for}"))
    }

    /// The next request is `method`; answer it with `reply`.
    async fn serve(&mut self, method: &str, reply: &[u8]) -> Result<()> {
        let request = self.request(method).await?;
        ensure!(
            request.method.as_deref() == Some(method),
            "{method}, not {:?}",
            request.method
        );
        self.answer(&request, reply).await
    }

    /// The next notice cancels exactly `request`, within [`PROMPTLY`].
    async fn cancels(&mut self, request: &Envelope) -> Result<()> {
        let cancel = tokio::time::timeout(PROMPTLY, self.notices.recv())
            .await
            .context("timed out waiting for a cancellation")?
            .context("the host closed the stream before a cancellation")?;
        ensure!(
            cancel.method.as_deref() == Some("$/cancelRequest"),
            "a cancellation, not {:?}",
            cancel.method
        );
        let cancelled: u32 = rmp_serde::from_slice(&cancel.payload)?;
        ensure!(
            Some(cancelled) == request.id,
            "exactly {:?}, not {cancelled}",
            request.id
        );
        Ok(())
    }

    /// Answer `request` with `payload`.
    pub(super) async fn answer(&mut self, request: &Envelope, payload: &[u8]) -> Result<()> {
        let response = Envelope {
            id: request.id,
            method: None,
            payload: payload.to_vec(),
            error: None,
        };
        self.transport.write_envelope(&response).await
    }

    /// Whether the host sends no request within [`QUIET`].
    pub(super) async fn stays_quiet(&mut self) -> bool {
        tokio::time::timeout(QUIET, self.transport.read_envelope())
            .await
            .is_err()
    }

    /// Whether the host sends no notice within [`QUIET`].
    async fn hears_no_notice(&mut self) -> bool {
        tokio::time::timeout(QUIET, self.notices.recv())
            .await
            .is_err()
    }
}
