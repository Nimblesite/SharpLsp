//! Framed async transport over Unix domain sockets.
//!
//! Frame format: 4-byte little-endian length prefix + `MessagePack` payload.

use anyhow::{Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tracing::trace;

use super::protocol::Envelope;

/// Async framed transport over a Unix domain socket.
pub struct FramedTransport {
    /// Underlying Unix domain socket connection.
    stream: UnixStream,
}

impl FramedTransport {
    /// Wrap an existing `UnixStream`.
    pub fn new(stream: UnixStream) -> Self {
        Self { stream }
    }

    /// Read one framed envelope. Returns `None` at EOF.
    pub async fn read_envelope(&mut self) -> Result<Option<Envelope>> {
        let mut len_buf = [0u8; 4];
        match self.stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(err) => return Err(err).context("read frame length"),
        }

        let len = u32::from_le_bytes(len_buf);
        let mut payload = vec![0u8; usize::try_from(len)?];
        let _ = self
            .stream
            .read_exact(&mut payload)
            .await
            .context("read frame payload")?;

        trace!(bytes = len, "received frame");

        let envelope: Envelope = rmp_serde::from_slice(&payload).context("deserialize envelope")?;
        Ok(Some(envelope))
    }

    /// Write one framed envelope.
    pub async fn write_envelope(&mut self, envelope: &Envelope) -> Result<()> {
        let payload = rmp_serde::to_vec_named(envelope).context("serialize envelope")?;
        let len = u32::try_from(payload.len()).context("frame too large")?;

        self.stream
            .write_all(&len.to_le_bytes())
            .await
            .context("write frame length")?;
        self.stream
            .write_all(&payload)
            .await
            .context("write frame payload")?;
        self.stream.flush().await.context("flush")?;

        trace!(bytes = len, "sent frame");
        Ok(())
    }
}
