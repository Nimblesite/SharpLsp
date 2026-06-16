using MessagePack;
using Serilog;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Logging;
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
    private IpcListener? _listener;
    private FramedTransport? _transport;

    /// <summary>Initializes the host, structured logging, and built-in handlers.</summary>
    /// <param name="name">Identifies the sidecar (e.g. "csharp") for its log file.</param>
    protected SidecarHost(string name)
    {
        SidecarLog.Initialize(name);
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
                Log.Error("Sidecar listener failed: {Error}", !listenerResult);
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
            Log.Error(ex, "Sidecar terminated with an unexpected error");
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

        if (_listener is not null)
        {
            await _listener.DisposeAsync().ConfigureAwait(false);
        }

        _shutdownCts.Dispose();
        SidecarLog.Shutdown();
        GC.SuppressFinalize(this);
    }

    private async Task AcceptAndRunLoopAsync(string socketPath)
    {
        Console.WriteLine($"READY:{socketPath}");
        await Console.Out.FlushAsync().ConfigureAwait(false);

        var stream = await _listener!.AcceptStreamAsync(_shutdownCts.Token).ConfigureAwait(false);
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
                Log.Error(ex, "Sidecar message loop error");
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
