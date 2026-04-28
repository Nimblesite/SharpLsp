using System.Net.Sockets;
using MessagePack;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.Common;

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

    /// <summary>Initializes the host and registers built-in handlers.</summary>
    protected SidecarHost()
    {
        _router.Register("ping", HandlePingAsync);
        _router.Register("shutdown", HandleShutdownAsync);
    }

    /// <summary>Register language-specific handlers.</summary>
    protected void Register(
        string method,
        Func<byte[], CancellationToken, Task<ByteResult>> handler
    )
    {
        _router.Register(method, handler);
    }

    /// <summary>Run the sidecar: listen, accept, dispatch until shutdown.</summary>
    public async Task RunAsync(string socketPath)
    {
        try
        {
            var listenerResult = IpcConnection.CreateListener(socketPath);
            if (listenerResult.IsError)
            {
                await Console
                    .Error.WriteLineAsync($"Listener failed: {!listenerResult}")
                    .ConfigureAwait(false);
                return;
            }

            _listener = +listenerResult;
            await AcceptAndRunLoopAsync(socketPath).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        { /* clean shutdown */
        }
        catch (Exception ex)
        {
            await Console
                .Error.WriteLineAsync($"Sidecar error: {ex.Message}")
                .ConfigureAwait(false);
        }
    }

    /// <summary>Shuts down the sidecar and releases all resources.</summary>
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

    private async Task AcceptAndRunLoopAsync(string socketPath)
    {
        Console.WriteLine($"READY:{socketPath}");
        await Console.Out.FlushAsync().ConfigureAwait(false);

        var client = await _listener!.AcceptAsync(_shutdownCts.Token).ConfigureAwait(false);
        var stream = new NetworkStream(client, ownsSocket: true);
        _transport = new FramedTransport(stream);

        await MessageLoopAsync().ConfigureAwait(false);
    }

    private async Task MessageLoopAsync()
    {
        var ct = _shutdownCts.Token;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!await ProcessOneMessageAsync(ct).ConfigureAwait(false))
                {
                    break;
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                await Console
                    .Error.WriteLineAsync($"Message error: {ex.Message}")
                    .ConfigureAwait(false);
            }
        }
    }

    private async Task<bool> ProcessOneMessageAsync(CancellationToken ct)
    {
        var frameBytes = await _transport!.ReadFrameAsync(ct).ConfigureAwait(false);
        if (frameBytes is null)
        {
            return false;
        }

        var envelope = MessagePackSerializer.Deserialize<Envelope>(
            frameBytes,
            cancellationToken: ct
        );
        var response = await _router.HandleAsync(envelope, ct).ConfigureAwait(false);
        if (response is null)
        {
            return true;
        }

        var responseBytes = MessagePackSerializer.Serialize(response, cancellationToken: ct);
        await _transport.WriteFrameAsync(responseBytes, ct).ConfigureAwait(false);
        return true;
    }

    private static Task<ByteResult> HandlePingAsync(byte[] _, CancellationToken ct)
    {
        try
        {
            var bytes = MessagePackSerializer.Serialize("pong", cancellationToken: ct);
            return Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(bytes));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ByteResult.Failure(ex.Message));
        }
    }

    private async Task<ByteResult> HandleShutdownAsync(byte[] _, CancellationToken ct)
    {
        try
        {
            var result = MessagePackSerializer.Serialize("ok", cancellationToken: ct);
            await _shutdownCts.CancelAsync().ConfigureAwait(false);
            return new ByteResult.Ok<byte[], string>(result);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
