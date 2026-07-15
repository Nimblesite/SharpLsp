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
    /// After this many consecutive message-loop failures the host gives up
    /// instead of hot-looping. A transport broken mid-frame makes every
    /// subsequent read throw rather than return the EOF sentinel, which would
    /// otherwise spin at 100% CPU flooding the log forever (GitHub #153).
    private const int MaxConsecutiveMessageFailures = 8;

    private readonly MessageRouter _router = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private IpcListener? _listener;
    private FramedTransport? _transport;

    /// <summary>
    /// True when the sidecar could not bind its endpoint and never reached
    /// READY. The process entry point maps this to a non-zero exit code so the
    /// failure is visible to the host instead of an opaque clean exit
    /// (GitHub #150, [DIST-FAILURE-UX]).
    /// </summary>
    public bool StartupFailed { get; private set; }

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
                await ReportStartupFailureAsync(!listenerResult).ConfigureAwait(false);
                return;
            }

            _listener = +listenerResult;
            await AcceptAndRunLoopAsync().ConfigureAwait(false);
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

    /// <summary>
    /// Announce a fatal startup failure on stderr — which the Rust host inherits
    /// into its own log — and flag the process for a non-zero exit. Without this
    /// a bind failure is visible only in a temp-file log, the opacity that made
    /// GitHub #110 take multiple log uploads to diagnose. Implements
    /// [DIST-FAILURE-UX] (GitHub #150).
    /// </summary>
    private async Task ReportStartupFailureAsync(string error)
    {
        StartupFailed = true;
        Log.Error("Sidecar listener failed: {Error}", error);
        await Console
            .Error.WriteLineAsync(
                $"FATAL: sidecar listener failed: {error}. See logs in {SidecarLog.LogDirectory}"
            )
            .ConfigureAwait(false);
        await Console.Error.FlushAsync().ConfigureAwait(false);
    }

    private async Task AcceptAndRunLoopAsync()
    {
        // Advertise the path the listener actually bound, not the requested one:
        // an overlong Unix endpoint is relocated, and the host connects to the
        // echoed path verbatim (GitHub #154).
        Console.WriteLine($"READY:{_listener!.BoundEndpoint}");
        await Console.Out.FlushAsync().ConfigureAwait(false);

        var stream = await _listener.AcceptStreamAsync(_shutdownCts.Token).ConfigureAwait(false);
        _transport = new FramedTransport(stream);

        await MessageLoopAsync().ConfigureAwait(false);
    }

    private async Task MessageLoopAsync()
    {
        var ct = _shutdownCts.Token;
        var consecutiveFailures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!await ProcessOneMessageAsync(ct).ConfigureAwait(false))
                {
                    break;
                }

                consecutiveFailures = 0;
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // The transport is permanently broken (peer died mid-frame); every
                // further read would throw rather than signal EOF. Exit the loop
                // instead of spinning on it (GitHub #153).
                Log.Error(ex, "Sidecar transport failed; ending message loop");
                break;
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Sidecar message loop error");
                if (++consecutiveFailures >= MaxConsecutiveMessageFailures)
                {
                    Log.Fatal(
                        "Sidecar message loop aborting after {Count} consecutive failures",
                        consecutiveFailures
                    );
                    break;
                }
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
