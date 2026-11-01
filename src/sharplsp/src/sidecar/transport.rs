//! Framed async transport over Unix domain sockets (Unix) or named pipes (Windows).
//!
//! `[SIDECAR-IPC-FRAMING]`: 4-byte little-endian length + `MessagePack` payload.

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tracing::trace;

use super::protocol::Envelope;

/// Maximum accepted frame payload size (64 MiB). `[SIDECAR-IPC-FRAMING]`
///
/// The host↔sidecar peers are same-user processes, so this is a
/// robustness/DoS guard rather than a trust boundary: it stops a corrupt or
/// runaway 4-byte length prefix (worst case `0xFFFF_FFFF` ≈ 4 GiB) from
/// triggering a giant `vec![0u8; len]` allocation and an indefinite blocking
/// read. 64 MiB comfortably exceeds any legitimate LSP payload — even large
/// semantic-token or workspace-symbol responses are far smaller.
const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// Async framed transport over a platform IPC stream.
pub struct FramedTransport {
    /// Responses separated from unsolicited compiler-workspace changes.
    responses: tokio::sync::mpsc::UnboundedReceiver<std::result::Result<Envelope, String>>,
    /// Notification receiver handed to the manager once per connection.
    notifications: Option<tokio::sync::mpsc::UnboundedReceiver<Envelope>>,
    /// Reader ownership ends with this transport.
    reader_task: tokio::task::JoinHandle<()>,
    /// Write half of the IPC stream.
    writer: Box<dyn AsyncWrite + Send + Unpin>,
}

impl FramedTransport {
    /// Wrap a platform stream into split read/write halves.
    #[cfg(unix)]
    pub fn new(stream: tokio::net::UnixStream) -> Self {
        let (reader, writer) = tokio::io::split(stream);
        Self::from_halves(reader, writer)
    }

    /// Wrap a platform stream into split read/write halves.
    #[cfg(windows)]
    pub fn new(pipe: tokio::net::windows::named_pipe::NamedPipeClient) -> Self {
        let (reader, writer) = tokio::io::split(pipe);
        Self::from_halves(reader, writer)
    }

    /// Wrap an arbitrary in-memory stream — test harnesses simulate a
    /// sidecar with `tokio::io::duplex` instead of a real process.
    #[cfg(test)]
    pub fn from_stream<S>(stream: S) -> Self
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let (reader, writer) = tokio::io::split(stream);
        Self::from_halves(reader, writer)
    }

    /// Use the shared codec-independent notification reader.
    fn from_halves<R, W>(reader: R, writer: W) -> Self
    where
        R: AsyncRead + Send + Unpin + 'static,
        W: AsyncWrite + Send + Unpin + 'static,
    {
        let inbound = lspkit::sidecar::inbound::spawn(
            reader,
            MAX_FRAME_LEN,
            |frame| rmp_serde::from_slice::<Envelope>(&frame).map_err(|error| error.to_string()),
            |envelope| envelope.id.is_none() && envelope.method.is_some(),
        );
        Self {
            responses: inbound.responses,
            notifications: Some(inbound.notifications),
            reader_task: inbound.task,
            writer: Box::new(writer),
        }
    }

    /// Hand idle and in-flight notifications to the manager exactly once.
    pub fn take_notifications(&mut self) -> Option<tokio::sync::mpsc::UnboundedReceiver<Envelope>> {
        self.notifications.take()
    }

    /// Read one framed envelope. Returns `None` at EOF.
    pub async fn read_envelope(&mut self) -> Result<Option<Envelope>> {
        self.responses
            .recv()
            .await
            .transpose()
            .map_err(anyhow::Error::msg)
    }

    /// Write one framed envelope.
    pub async fn write_envelope(&mut self, envelope: &Envelope) -> Result<()> {
        let payload = rmp_serde::to_vec_named(envelope).context("serialize envelope")?;
        let len = u32::try_from(payload.len()).context("frame too large")?;
        if payload.len() > MAX_FRAME_LEN {
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

impl Drop for FramedTransport {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

#[cfg(test)]
#[cfg_attr(
    unix,
    expect(
        clippy::expect_used,
        clippy::panic_in_result_fn,
        reason = "test code — a failed assert IS the failure mode; returning Err instead would hide which condition broke"
    )
)]
mod tests {
    // Framing and payload-bound coverage: [SIDECAR-IPC-FRAMING].
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
