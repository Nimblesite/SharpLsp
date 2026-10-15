using SharpLsp.Sidecar.Common.Supervision;

#pragma warning disable RS1035 // Real-process use is intentional: supervision is proven against real processes

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// The sidecar notices its host's death against a real, separately spawned
/// stand-in host. Implements [SIDECAR-PROCESS-PARENT] (GitHub #163).
/// </summary>
public sealed class ParentProcessWatchdogTests
{
    /// The spec bounds detection at one second; allow scheduling slack on CI.
    private static readonly TimeSpan DetectionBound = TimeSpan.FromSeconds(3);

    private static ParentProcessWatchdog Started(int pid, Action onExit)
    {
        var result = ParentProcessWatchdog.Start(pid, onExit);
        Assert.False(result.IsError, result.Match(_ => string.Empty, e => e));
        return result.Match(w => w, _ => throw new InvalidOperationException());
    }

    [Fact]
    public async Task Host_death_fires_the_callback_once_within_the_bound()
    {
        using var host = StandInProcess.StartIdle();
        var fired = 0;
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var watchdog = Started(
            host.Id,
            () =>
            {
                _ = Interlocked.Increment(ref fired);
                _ = exited.TrySetResult();
            }
        );

        await Task.Delay(300).ConfigureAwait(true);
        Assert.Equal(0, Volatile.Read(ref fired));
        Assert.False(watchdog.Completion.IsCompleted, "a live host must keep the watch open");

        host.Kill();
        var detected = await Task.WhenAny(exited.Task, Task.Delay(DetectionBound))
            .ConfigureAwait(true);
        Assert.Same(exited.Task, detected);
        await watchdog.Completion.WaitAsync(DetectionBound).ConfigureAwait(true);
        Assert.Equal(1, Volatile.Read(ref fired));
    }

    [Fact]
    public async Task Disposing_the_watchdog_ends_the_watch_without_firing()
    {
        using var host = StandInProcess.StartIdle();
        var fired = false;
        var watchdog = Started(host.Id, () => fired = true);

        watchdog.Dispose();
        await watchdog.Completion.WaitAsync(DetectionBound).ConfigureAwait(true);
        Assert.False(fired, "a disposed watchdog must never report host death");

        host.Kill();
        await host.WaitForExitAsync().ConfigureAwait(true);
        await Task.Delay(500).ConfigureAwait(true);
        Assert.False(fired, "host death after disposal must not reach the callback");
    }

    [Fact]
    public async Task A_host_that_is_already_gone_cannot_be_watched()
    {
        var fired = false;
        var gone = await StandInProcess.ExitedPidAsync().ConfigureAwait(true);

        var result = ParentProcessWatchdog.Start(gone, () => fired = true);

        Assert.True(result.IsError, "a sidecar must not reach READY without a live host");
        Assert.Contains(
            $"{gone}",
            result.Match(_ => string.Empty, e => e),
            StringComparison.Ordinal
        );
        Assert.False(fired);
    }
}
