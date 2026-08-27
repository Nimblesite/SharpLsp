using System.Buffers.Binary;
using SharpLsp.Sidecar.Common.Ipc;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Guards the 64 MiB frame-length cap that stops a corrupt or hostile 4-byte
/// length prefix from forcing a multi-gigabyte allocation (DoS hardening that
/// mirrors MAX_FRAME_LEN in the Rust host transport).
/// </summary>
public sealed class FramedTransportTests
{
    private const uint MaxFrameLength = 64 * 1024 * 1024;

    [Fact]
    public async Task ReadFrameAsync_rejects_oversized_length_prefix()
    {
        var prefix = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix, MaxFrameLength + 1);
        var stream = new MemoryStream(prefix);
        var transport = new FramedTransport(stream);
        await using var transportLease = transport.ConfigureAwait(true);

        // The length is rejected before the payload is allocated or read.
        _ = await Assert
            .ThrowsAsync<InvalidDataException>(async () =>
                await transport.ReadFrameAsync().ConfigureAwait(true)
            )
            .ConfigureAwait(true);
    }

    [Fact]
    public async Task WriteFrameAsync_rejects_oversized_payload()
    {
        var stream = new MemoryStream();
        var transport = new FramedTransport(stream);
        await using var transportLease = transport.ConfigureAwait(true);
        var payload = new byte[MaxFrameLength + 1];

        _ = await Assert
            .ThrowsAsync<InvalidDataException>(async () =>
                await transport.WriteFrameAsync(payload).ConfigureAwait(true)
            )
            .ConfigureAwait(true);
    }

    [Fact]
    public async Task ReadFrameAsync_accepts_a_normal_frame()
    {
        // A small, well-formed frame still round-trips — the cap only rejects
        // lengths strictly greater than the maximum, not normal traffic.
        var body = new byte[] { 0xDE, 0xAD, 0xBE, 0xEF };
        var framed = new byte[4 + body.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)body.Length);
        body.CopyTo(framed, 4);

        var stream = new MemoryStream(framed);
        var transport = new FramedTransport(stream);
        await using var transportLease = transport.ConfigureAwait(true);

        var read = await transport.ReadFrameAsync().ConfigureAwait(true);

        Assert.NotNull(read);
        Assert.Equal(body, read);
    }

    [Fact]
    public async Task ReadFrameAsync_returns_null_at_end_of_stream()
    {
        // An empty stream yields no length prefix, signalling a closed peer.
        var transport = new FramedTransport(new MemoryStream());
        await using var transportLease = transport.ConfigureAwait(true);

        Assert.Null(await transport.ReadFrameAsync().ConfigureAwait(true));
    }

    [Fact]
    public async Task ReadFrameAsync_returns_empty_for_a_zero_length_frame()
    {
        // A valid length prefix of zero is a legitimate empty payload, not EOF.
        var prefix = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(prefix, 0);
        var transport = new FramedTransport(new MemoryStream(prefix));
        await using var transportLease = transport.ConfigureAwait(true);

        var read = await transport.ReadFrameAsync().ConfigureAwait(true);

        Assert.NotNull(read);
        Assert.Empty(read!);
    }

    [Fact]
    public async Task ReadFrameAsync_returns_null_when_payload_is_truncated()
    {
        // The prefix promises four bytes but only one follows; the truncated
        // payload read hits end-of-stream and the frame is abandoned.
        var truncated = new byte[5];
        BinaryPrimitives.WriteUInt32LittleEndian(truncated, 4);
        truncated[4] = 0x42;
        var transport = new FramedTransport(new MemoryStream(truncated));
        await using var transportLease = transport.ConfigureAwait(true);

        Assert.Null(await transport.ReadFrameAsync().ConfigureAwait(true));
    }
}
