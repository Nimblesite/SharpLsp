using System.ComponentModel;
using System.Diagnostics;
using Serilog;
using WatchdogResult = Outcome.Result<
    SharpLsp.Sidecar.Common.Supervision.ParentProcessWatchdog,
    string
>;

namespace SharpLsp.Sidecar.Common.Supervision;

/// <summary>
/// Fires once when the host process that launched the sidecar exits. Without
/// it a host killed hard — before or after the IPC connect — leaves the sidecar
/// waiting forever, still holding its endpoint.
/// On Windows it waits on a handle to the exact parent process object, opened
/// at start, so a recycled PID can never impersonate the parent. On Unix it
/// polls the PID's liveness within the one-second detection bound.
/// Implements [SIDECAR-PROCESS-PARENT] (GitHub #163).
/// </summary>
public sealed class ParentProcessWatchdog : IDisposable
{
    /// <summary>Unix liveness poll interval; well inside the 1s detection bound.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(250);

    private readonly Process _parent;
    private readonly int _parentPid;
    private readonly CancellationTokenSource _stop = new();

    private ParentProcessWatchdog(Process parent, int parentPid)
    {
        _parent = parent;
        _parentPid = parentPid;
    }

    /// <summary>Completes when the watch ends: the parent exited or the watchdog was disposed.</summary>
    public Task Completion { get; private set; } = Task.CompletedTask;

    /// <summary>
    /// Start watching <paramref name="parentPid" />. Fails when the parent is
    /// already gone or cannot be opened — a sidecar must not reach READY with
    /// no live host to serve.
    /// </summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Process ownership transfers to the watchdog via Result"
    )]
    public static WatchdogResult Start(int parentPid, Action onParentExit)
    {
        Process? parent = null;
        try
        {
            parent = Process.GetProcessById(parentPid);
            return Watch(parent, parentPid, onParentExit);
        }
        catch (Exception ex)
            when (ex is ArgumentException or InvalidOperationException or Win32Exception)
        {
            // Ownership never transferred: release the handle a failed open left behind.
            parent?.Dispose();
            return WatchdogResult.Failure($"cannot watch parent process {parentPid}: {ex.Message}");
        }
    }

    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Reliability",
        "CA2000:Dispose objects before losing scope",
        Justification = "Process ownership transfers to the watchdog via Result"
    )]
    private static WatchdogResult Watch(Process parent, int parentPid, Action onParentExit)
    {
        // Opening the handle now pins the exact process object.
        _ = parent.SafeHandle;
        if (parent.HasExited)
        {
            parent.Dispose();
            return WatchdogResult.Failure($"parent process {parentPid} has already exited");
        }

        var watchdog = new ParentProcessWatchdog(parent, parentPid);
        watchdog.Completion = watchdog.WatchAsync(onParentExit);
        return new WatchdogResult.Ok<ParentProcessWatchdog, string>(watchdog);
    }

    /// <summary>Stop watching without firing the callback.</summary>
    public void Dispose()
    {
        _stop.Cancel();
        _stop.Dispose();
    }

    /// The watch owns the parent handle and releases it only once it has ended:
    /// disposing it from <see cref="Dispose" /> raced the Unix liveness poll,
    /// which then faulted reading <c>HasExited</c> on a disposed process.
    private async Task WatchAsync(Action onParentExit)
    {
        try
        {
            await WaitForParentExitAsync(_stop.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        finally
        {
            _parent.Dispose();
        }

        Log.Warning("Host process {ParentPid} exited; sidecar is shutting down", _parentPid);
        onParentExit();
    }

    private async Task WaitForParentExitAsync(CancellationToken ct)
    {
        if (OperatingSystem.IsWindows())
        {
            await _parent.WaitForExitAsync(ct).ConfigureAwait(false);
            return;
        }

        while (!_parent.HasExited)
        {
            await Task.Delay(PollInterval, ct).ConfigureAwait(false);
        }
    }
}
