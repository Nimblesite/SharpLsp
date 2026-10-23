//! One framed exchange for ordinary requests and compiler-session replay.
use std::sync::atomic::Ordering;
use std::time::Duration;

use anyhow::{bail, Context, Result};
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
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        info!(sidecar = %self.name, method, id, "Sidecar request");
        let envelope = Envelope::request(id, method, payload);
        let transport = connection.as_mut().context("sidecar not connected")?;
        let payload = match tokio::time::timeout(budget, roundtrip(transport, &envelope)).await {
            Ok(response) => self.response_payload(response?, method, id)?,
            Err(_) => {
                return self
                    .fail_timed_out_request(connection, method, id, budget)
                    .await
            }
        };
        // TODO [SIDECAR-RECOVERY-BACKOFF]: reset only after 60 seconds continuously Ready.
        *self.backoff.lock().await = INITIAL_BACKOFF;
        Ok(payload)
    }

    /// Accept only the response correlated with the current framed request.
    fn response_payload(&self, response: Envelope, method: &str, id: u32) -> Result<Vec<u8>> {
        if response.id != Some(id) {
            bail!("sidecar response does not match current request {id}");
        }
        if let Some(error) = response.error {
            error!(sidecar = %self.name, method, id, %error, "Sidecar error");
            bail!("sidecar error: {error}");
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

/// Use the shared transport framing for exactly one request and response.
async fn roundtrip(transport: &mut FramedTransport, request: &Envelope) -> Result<Envelope> {
    transport.write_envelope(request).await?;
    transport
        .read_envelope()
        .await?
        .context("sidecar closed connection")
}
