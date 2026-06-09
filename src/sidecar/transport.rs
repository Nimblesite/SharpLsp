//! Framed async transport over Unix domain sockets (Unix) or named pipes (Windows).
//!
//! Frame format: 4-byte little-endian length prefix + `MessagePack` payload.

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tracing::trace;

use super::protocol::Envelope;

/// Maximum accepted frame payload size (64 MiB).
///
/// The host↔sidecar peers are same-user processes, so this is a
/// robustness/DoS guard rather than a trust boundary: it stops a corrupt or
/// runaway 4-byte length prefix (worst case `0xFFFF_FFFF` ≈ 4 GiB) from
/// triggering a giant `vec![0u8; len]` allocation and an indefinite blocking
/// read. 64 MiB comfortably exceeds any legitimate LSP payload — even large
/// semantic-token or workspace-symbol responses are far smaller.
const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;

/// Async framed transport over a platform IPC stream.
pub struct FramedTransport {
    /// Read half of the IPC stream.
    reader: Box<dyn AsyncRead + Send + Unpin>,
    /// Write half of the IPC stream.
    writer: Box<dyn AsyncWrite + Send + Unpin>,
}

impl FramedTransport {
    /// Wrap a platform stream into split read/write halves.
    #[cfg(unix)]
    pub fn new(stream: tokio::net::UnixStream) -> Self {
        let (reader, writer) = tokio::io::split(stream);
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
        }
    }

    /// Wrap a platform stream into split read/write halves.
    #[cfg(windows)]
    pub fn new(pipe: tokio::net::windows::named_pipe::NamedPipeClient) -> Self {
        let (reader, writer) = tokio::io::split(pipe);
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
        }
    }

    /// Read one framed envelope. Returns `None` at EOF.
    pub async fn read_envelope(&mut self) -> Result<Option<Envelope>> {
        let mut len_buf = [0u8; 4];
        match self.reader.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(err) => return Err(err).context("read frame length"),
        }

        let len = u32::from_le_bytes(len_buf);
        if len > MAX_FRAME_LEN {
            anyhow::bail!("frame length {len} exceeds maximum {MAX_FRAME_LEN} bytes");
        }
        let mut payload = vec![0u8; usize::try_from(len)?];
        let _ = self
            .reader
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
        if len > MAX_FRAME_LEN {
            anyhow::bail!("outgoing frame length {len} exceeds maximum {MAX_FRAME_LEN} bytes");
        }

        self.writer
            .write_all(&len.to_le_bytes())
            .await
            .context("write frame length")?;
        self.writer
            .write_all(&payload)
            .await
            .context("write frame payload")?;
        self.writer.flush().await.context("flush")?;

        trace!(bytes = len, "sent frame");
        Ok(())
    }
}

#[cfg(test)]
#[cfg_attr(
    unix,
    expect(
        clippy::expect_used,
        reason = "test code — expect() is the correct failure mode"
    )
)]
mod tests {
    #[cfg(unix)]
    use super::*;
    #[cfg(unix)]
    use anyhow::Result;

    /// Build a `FramedTransport` pair connected via an in-memory socket pair.
    #[cfg(unix)]
    fn make_transport_pair() -> Result<(FramedTransport, FramedTransport)> {
        let (client, server) = tokio::net::UnixStream::pair().context("create UnixStream pair")?;
        Ok((FramedTransport::new(client), FramedTransport::new(server)))
    }

    /// Round-trip an `Envelope` through `write_envelope` / `read_envelope`.
    #[cfg(unix)]
    #[tokio::test]
    async fn round_trips_envelope() -> Result<()> {
        let (mut writer_transport, mut reader_transport) = make_transport_pair()?;
        let original = Envelope::request(7, "test/method", vec![0xDE, 0xAD, 0xBE, 0xEF]);

        writer_transport
            .write_envelope(&original)
            .await
            .expect("write_envelope should succeed");

        let received = reader_transport
            .read_envelope()
            .await
            .expect("read_envelope should succeed")
            .expect("envelope should be present, not EOF");

        assert_eq!(received.id, original.id);
        assert_eq!(received.method, original.method);
        assert_eq!(received.payload, original.payload);
        assert_eq!(received.error, original.error);
        Ok(())
    }

    /// `read_envelope` must return `None` when the peer closes the connection.
    #[cfg(unix)]
    #[tokio::test]
    async fn returns_none_on_eof() -> Result<()> {
        let (client, server) = tokio::net::UnixStream::pair().context("create UnixStream pair")?;
        let mut reader_transport = FramedTransport::new(server);

        // Drop the writer end — this closes the write half, causing EOF.
        drop(client);

        let result = reader_transport
            .read_envelope()
            .await
            .expect("read_envelope should not error on EOF");
        assert!(result.is_none(), "expected None at EOF, got Some(_)");
        Ok(())
    }

    /// A length prefix larger than `MAX_FRAME_LEN` must be rejected before any
    /// allocation, rather than triggering a multi-gigabyte `vec![0u8; len]`.
    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_oversized_frame_length() -> Result<()> {
        let (mut client, server) =
            tokio::net::UnixStream::pair().context("create UnixStream pair")?;
        let mut reader_transport = FramedTransport::new(server);

        // Announce a payload one byte larger than the cap, then send nothing.
        let oversized = MAX_FRAME_LEN + 1;
        client
            .write_all(&oversized.to_le_bytes())
            .await
            .expect("write oversized length prefix");
        client.flush().await.expect("flush length prefix");

        let result = reader_transport.read_envelope().await;
        assert!(
            result.is_err(),
            "an oversized frame length must be rejected, not allocated"
        );
        Ok(())
    }
}
