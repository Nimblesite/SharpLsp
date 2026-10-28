//! One framed exchange for ordinary requests and compiler-session replay.
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use lspkit_server::CancellationToken;
use lspkit_sidecar::cancellation::{Reply, RequestCancelled};
use tracing::{error, info, warn};

use super::{SidecarManager, INITIAL_BACKOFF};
use crate::sidecar::protocol::Envelope;
use crate::sidecar::transport::FramedTransport;

impl SidecarManager {
    /// Caller retains the FIFO connection lock throughout every exchange.
    pub(super) async fn exchange(
        &self,
        connection: &mut Option<FramedTransport>,
        method: &str,
        payload: Vec<u8>,
        budget: Duration,
    ) -> Result<Vec<u8>> {
        self.exchange_cancellable(connection, method, payload, budget, None)
            .await
    }

    /// Cancel compiler execution without releasing the FIFO before its terminal reply.
    /// Implements [DIAG-ANALYSIS-CANCELLATION].
    pub(super) async fn exchange_cancellable(
        &self,
        connection: &mut Option<FramedTransport>,
        method: &str,
        payload: Vec<u8>,
        budget: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<Vec<u8>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        info!(sidecar = %self.name, method, id, "Sidecar request");
        let envelope = Envelope::request(id, method, payload);
        let response = self
            .timed_reply(connection, &envelope, budget, cancel)
            .await?;
        let payload = self.completed_payload(response, method, id)?;
        // TODO [SIDECAR-RECOVERY-BACKOFF]: reset only after 60 seconds continuously Ready.
        *self.backoff.lock().await = INITIAL_BACKOFF;
        Ok(payload)
    }

    /// The timeout owns disconnection; cancellation retires the reply on this connection.
    async fn timed_reply(
        &self,
        connection: &mut Option<FramedTransport>,
        envelope: &Envelope,
        budget: Duration,
        cancel: Option<&CancellationToken>,
    ) -> Result<Reply<Envelope>> {
        let transport = connection.as_mut().context("sidecar not connected")?;
        if let Ok(response) =
            tokio::time::timeout(budget, roundtrip(transport, envelope, cancel)).await
        {
            response
        } else {
            let (method, id) = request_identity(envelope)?;
            self.fail_timed_out_request(connection, method, id, budget)
                .await
        }
    }

    /// A cancelled terminal frame still has to match its original request identity.
    fn completed_payload(
        &self,
        response: Reply<Envelope>,
        method: &str,
        id: u32,
    ) -> Result<Vec<u8>> {
        match response {
            Reply::Complete(response) => self.response_payload(response, method, id),
            Reply::Cancelled(response) => {
                validate_response_id(&response, id)?;
                info!(sidecar = %self.name, method, id, "Sidecar request cancelled");
                Err(RequestCancelled.into())
            }
        }
    }

    /// Accept only the response correlated with the current framed request.
    fn response_payload(&self, response: Envelope, method: &str, id: u32) -> Result<Vec<u8>> {
        validate_response_id(&response, id)?;
        if let Some(error) = response.error {
            error!(sidecar = %self.name, method, id, %error, "Sidecar error");
            return Err(CompilerRefusal(error).into());
        }
        info!(sidecar = %self.name, method, id, bytes = response.payload.len(), "Sidecar response");
        Ok(response.payload)
    }

    /// A failed replay or timed-out exchange cannot leave a usable empty session.
    pub(super) async fn disconnect(&self, connection: &mut Option<FramedTransport>) {
        *connection = None;
        if let Some(mut child) = self.child.lock().await.take() {
            if let Err(error) = child.kill().await {
                warn!(sidecar = %self.name, %error, "Could not terminate disconnected compiler");
            }
        }
    }
}

/// A compiler's own error reply: it answered, and refused the request. The
/// connection stays usable, unlike a transport failure or a timeout.
#[derive(Debug)]
pub(crate) struct CompilerRefusal(String);

impl std::fmt::Display for CompilerRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sidecar error: {}", self.0)
    }
}

impl std::error::Error for CompilerRefusal {}

/// Require an ordinary request identity before handling its timeout.
fn request_identity(request: &Envelope) -> Result<(&str, u32)> {
    Ok((
        request
            .method
            .as_deref()
            .context("missing request method")?,
        request.id.context("missing request identity")?,
    ))
}

/// Use the shared transport framing for exactly one request and response.
async fn roundtrip(
    transport: &mut FramedTransport,
    request: &Envelope,
    cancel: Option<&CancellationToken>,
) -> Result<Reply<Envelope>> {
    transport.write_envelope(request).await?;
    let mut exchange = CompilerExchange {
        transport,
        id: request.id.context("missing request identity")?,
    };
    lspkit_sidecar::cancellation::receive(&mut exchange, cancel)
        .await
        .map_err(anyhow::Error::msg)
}

/// Root's codec adapter; scheduling and terminal retirement live in lspkit.
struct CompilerExchange<'a> {
    /// The existing background reader preserves partially received wire frames.
    transport: &'a mut FramedTransport,
    /// Exactly the active ordinary request, never a shared cancellation identity.
    id: u32,
}

impl lspkit_sidecar::cancellation::Exchange for CompilerExchange<'_> {
    type Response = Envelope;

    async fn receive(&mut self) -> Result<Envelope, String> {
        self.transport
            .read_envelope()
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "sidecar closed connection".to_owned())
    }

    async fn cancel(&mut self) -> Result<(), String> {
        let payload = rmp_serde::to_vec(&self.id).map_err(|error| error.to_string())?;
        let notice = Envelope {
            id: None,
            method: Some("$/cancelRequest".to_owned()),
            payload,
            error: None,
        };
        self.transport
            .write_envelope(&notice)
            .await
            .map_err(|error| error.to_string())
    }
}

/// The serialized connection cannot consume another request's response.
fn validate_response_id(response: &Envelope, id: u32) -> Result<()> {
    if response.id != Some(id) {
        bail!("sidecar response does not match current request {id}");
    }
    Ok(())
}
