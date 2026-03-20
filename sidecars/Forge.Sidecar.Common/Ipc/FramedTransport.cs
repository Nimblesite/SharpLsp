using System.Buffers.Binary;

namespace Forge.Sidecar.Common.Ipc;

/// <summary>
/// Reads and writes length-prefixed frames over a stream.
/// Frame format: 4-byte little-endian length prefix + payload bytes.
/// </summary>
public sealed class FramedTransport : IAsyncDisposable
{
    private readonly Stream _stream;
    private readonly byte[] _lengthBuffer = new byte[4];
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public FramedTransport(Stream stream)
    {
        _stream = stream ?? throw new ArgumentNullException(nameof(stream));
    }

    /// <summary>Read one complete frame. Returns null at end-of-stream.</summary>
    public async Task<byte[]?> ReadFrameAsync(CancellationToken ct = default)
    {
        var bytesRead = await ReadExactAsync(_lengthBuffer, ct).ConfigureAwait(false);
        if (!bytesRead)
        {
            return null;
        }

        var length = BinaryPrimitives.ReadUInt32LittleEndian(_lengthBuffer);
        if (length is 0)
        {
            return [];
        }

        var payload = new byte[length];
        var payloadRead = await ReadExactAsync(payload, ct).ConfigureAwait(false);
        if (!payloadRead)
        {
            return null;
        }

        return payload;
    }

    /// <summary>Write one length-prefixed frame.</summary>
    public async Task WriteFrameAsync(byte[] payload, CancellationToken ct = default)
    {
        var lengthPrefix = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lengthPrefix, (uint)payload.Length);

        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(lengthPrefix, ct).ConfigureAwait(false);
            await _stream.WriteAsync(payload, ct).ConfigureAwait(false);
            await _stream.FlushAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stream.DisposeAsync().ConfigureAwait(false);
        _writeLock.Dispose();
    }

    private async Task<bool> ReadExactAsync(byte[] buffer, CancellationToken ct)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await _stream.ReadAsync(
                buffer.AsMemory(offset, buffer.Length - offset), ct)
                .ConfigureAwait(false);
            if (read is 0)
            {
                return false;
            }

            offset += read;
        }

        return true;
    }
}
