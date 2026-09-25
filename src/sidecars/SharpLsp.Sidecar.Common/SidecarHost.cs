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
/// Managed listener/dispatch portion of [SIDECAR-ARCHITECTURE-OWNERSHIP].
/// </summary>
public abstract class SidecarHost : IAsyncDisposable
{
    /// After this many consecutive message-loop failures the host gives up
    /// instead of hot-looping. A transport broken mid-frame makes every
    /// subsequent read throw rather than return the EOF sentinel, which would
    /// otherwise spin at 100% CPU flooding the log forever (GitHub #153).
    private const int MaxConsecutiveMessageFailures = 8;

    /// Ceiling on writing one response. A peer that stopped reading must not
    /// hold the loop — or the shutdown acknowledgement — forever
    /// ([SIDECAR-SHUTDOWN-ACK]).
    private static readonly TimeSpan ResponseWriteBudget = TimeSpan.FromSeconds(5);

    private readonly MessageRouter _router = new();
    private readonly CancellationTokenSource _shutdownCts = new();
    private IpcListener? _listener;
    private FramedTransport? _transport;

    /// Set by the shutdown handler; the loop acts on it only once the
    /// handler's acknowledgement is flushed ([SIDECAR-SHUTDOWN-ACK]).
    private bool _stopRequested;

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
            // TODO [SIDECAR-PROCESS-PARENT]: install and validate the watcher before binding.
            // TODO [SIDECAR-PROCESS-TREE]: establish platform containment before READY.
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
        await CloseAsync().ConfigureAwait(false);
        await DisposeCoreAsync().ConfigureAwait(false);
        _shutdownCts.Dispose();
        SidecarLog.Shutdown();
        GC.SuppressFinalize(this);
    }

    /// <summary>
    /// Release what a concrete sidecar owns — a workspace, and any process it started
    /// — once the connection is closed and before the log is. The process entry point
    /// disposes the sidecar the moment its message loop ends, so anything not released
    /// here outlives the sidecar.
    /// </summary>
    protected virtual ValueTask DisposeCoreAsync()
    {
        return ValueTask.CompletedTask;
    }

    /// <summary>
    /// Stop dispatch, then close the connection and the listener. An
    /// acknowledged shutdown ends here, so the peer reads end of stream, and
    /// disposal ends here again: closing twice is harmless, and a cancelled
    /// source is never cancelled twice — disposal cancels before it disposes,
    /// so this never touches a disposed one.
    /// </summary>
    private async Task CloseAsync()
    {
        if (!_shutdownCts.IsCancellationRequested)
        {
            await _shutdownCts.CancelAsync().ConfigureAwait(false);
        }

        if (_transport is not null)
        {
            await _transport.DisposeAsync().ConfigureAwait(false);
        }

        if (_listener is not null)
        {
            await _listener.DisposeAsync().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Announce a fatal startup failure on stderr — which the Rust host inherits
    /// into its own log — and flag the process for a non-zero exit. Without this
    /// a bind failure is visible only in a temp-file log, the opacity that made
    /// GitHub #110 take multiple log uploads to diagnose. Listener-bind failure
    /// path for [SIDECAR-STARTUP-FAILURE] and [DIST-FAILURE-UX] (GitHub #150).
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
        // TODO [SIDECAR-STARTUP-HANDSHAKE]: emit the versioned READY JSON record.
        // Advertise the path the listener actually bound, not the requested one:
        // an overlong Unix endpoint is relocated, and the host connects to the
        // echoed path verbatim (GitHub #154).
        Console.WriteLine($"READY:{_listener!.BoundEndpoint}");
        await Console.Out.FlushAsync().ConfigureAwait(false);

        var stream = await _listener.AcceptStreamAsync(_shutdownCts.Token).ConfigureAwait(false);
        _transport = new FramedTransport(stream);

        await MessageLoopAsync(_transport).ConfigureAwait(false);
        if (_stopRequested)
        {
            // The acknowledgement is flushed: only now stop dispatch and close,
            // so the process exits zero with the peer already answered.
            await CloseAsync().ConfigureAwait(false);
        }
    }

    private async Task MessageLoopAsync(FramedTransport transport)
    {
        // Terminal and bounded failure behavior: [SIDECAR-IPC-MESSAGE-LOOP].
        var ct = _shutdownCts.Token;
        var consecutiveFailures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (!await ProcessOneMessageAsync(transport, ct).ConfigureAwait(false))
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

    /// <summary>
    /// Read, dispatch and answer one frame; false once the loop must end — at
    /// end of stream, or once a shutdown's acknowledgement is flushed.
    /// </summary>
    private async Task<bool> ProcessOneMessageAsync(FramedTransport transport, CancellationToken ct)
    {
        var frameBytes = await transport.ReadFrameAsync(ct).ConfigureAwait(false);
        if (frameBytes is null)
        {
            return false;
        }

        var envelope = MessagePackSerializer.Deserialize<Envelope>(
            frameBytes,
            cancellationToken: ct
        );
        var response = await _router.HandleAsync(envelope, ct).ConfigureAwait(false);
        if (response is not null)
        {
            await WriteResponseAsync(transport, response, ct).ConfigureAwait(false);
        }

        return !_stopRequested;
    }

    /// Write and flush one response within <see cref="ResponseWriteBudget" />.
    private static async Task WriteResponseAsync(
        FramedTransport transport,
        Envelope response,
        CancellationToken ct
    )
    {
        using var bounded = CancellationTokenSource.CreateLinkedTokenSource(ct);
        bounded.CancelAfter(ResponseWriteBudget);
        var bytes = MessagePackSerializer.Serialize(response, cancellationToken: bounded.Token);
        await transport.WriteFrameAsync(bytes, bounded.Token).ConfigureAwait(false);
    }

    // Ping responder for [SIDECAR-HEALTH-ACTIVITY].
    private static Task<ByteResult> HandlePingAsync(byte[] _, CancellationToken ct)
    {
        return Task.FromResult(Serialized("pong", ct));
    }

    /// <summary>
    /// Acknowledge shutdown WITHOUT stopping anything: cancelling here would
    /// cancel the very write that carries the "ok" (GitHub #172). The loop
    /// stops once the acknowledgement is flushed ([SIDECAR-SHUTDOWN-ACK]).
    /// </summary>
    private Task<ByteResult> HandleShutdownAsync(byte[] _, CancellationToken ct)
    {
        var reply = Serialized("ok", ct);
        _stopRequested = !reply.IsError;
        return Task.FromResult(reply);
    }

    /// <summary>
    /// A handler's answer, serialized for the wire. A value that cannot be
    /// serialized is that handler's failure, never an exception in the loop.
    /// </summary>
    protected static ByteResult Serialized<T>(T value, CancellationToken ct)
    {
        try
        {
            var bytes = MessagePackSerializer.Serialize(value, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
