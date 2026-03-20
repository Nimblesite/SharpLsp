using System.Net.Sockets;
using Forge.Sidecar.Common.Ipc;
using Forge.Sidecar.Common.Messages;
using MessagePack;

namespace Forge.Sidecar.Common;

/// <summary>
/// Base class for sidecar processes. Handles socket lifecycle,
/// message dispatch, ping/pong health checks, and graceful shutdown.
/// </summary>
public abstract class SidecarHost : IAsyncDisposable
{
    private readonly MessageRouter _router = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private Socket? _listener;
    private FramedTransport? _transport;

    protected SidecarHost()
    {
        _router.Register("ping", HandlePingAsync);
        _router.Register("shutdown", HandleShutdownAsync);
    }

    /// <summary>Register language-specific handlers.</summary>
    protected void Register(string method, Func<byte[], CancellationToken, Task<byte[]>> handler)
    {
        _router.Register(method, handler);
    }

    /// <summary>Run the sidecar: listen, accept, dispatch until shutdown.</summary>
    public async Task RunAsync(string socketPath)
    {
        _listener = IpcConnection.CreateListener(socketPath);

        // Signal readiness to the Rust host via stdout.
        Console.WriteLine($"READY:{socketPath}");
        Console.Out.Flush();

        var client = await _listener.AcceptAsync(_shutdownCts.Token).ConfigureAwait(false);
        var stream = new NetworkStream(client, ownsSocket: true);
        _transport = new FramedTransport(stream);

        await MessageLoopAsync().ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        await _shutdownCts.CancelAsync().ConfigureAwait(false);

        if (_transport is not null)
        {
            await _transport.DisposeAsync().ConfigureAwait(false);
        }

        _listener?.Dispose();
        _shutdownCts.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task MessageLoopAsync()
    {
        var ct = _shutdownCts.Token;
        while (!ct.IsCancellationRequested)
        {
            var frameBytes = await _transport!.ReadFrameAsync(ct).ConfigureAwait(false);
            if (frameBytes is null)
            {
                break;
            }

            var envelope = MessagePackSerializer.Deserialize<Envelope>(frameBytes, cancellationToken: ct);
            var response = await _router.HandleAsync(envelope, ct).ConfigureAwait(false);

            if (response is not null)
            {
                var responseBytes = MessagePackSerializer.Serialize(response, cancellationToken: ct);
                await _transport.WriteFrameAsync(responseBytes, ct).ConfigureAwait(false);
            }
        }
    }

    private Task<byte[]> HandlePingAsync(byte[] payload, CancellationToken ct)
    {
        return Task.FromResult(MessagePackSerializer.Serialize("pong", cancellationToken: ct));
    }

    private async Task<byte[]> HandleShutdownAsync(byte[] payload, CancellationToken ct)
    {
        var result = MessagePackSerializer.Serialize("ok", cancellationToken: ct);
        await _shutdownCts.CancelAsync().ConfigureAwait(false);
        return result;
    }
}
