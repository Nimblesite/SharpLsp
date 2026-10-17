using System.Diagnostics;
using SharpLsp.Sidecar.Common.Ipc;

#pragma warning disable RS1035 // Console capture is intentional: READY and FATAL are the host-visible contract

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A supervised sidecar binds only while its host lives and lets go of
/// everything once the host is gone — before READY or after it. Implements
/// [SIDECAR-PROCESS-PARENT] and [SIDECAR-STARTUP-FAILURE] (GitHub #163).
///
/// Shares the <c>SerilogGlobalLogger</c> collection: the host swaps the
/// process-global logger, and these tests swap the process-global console.
/// </summary>
[Collection("SerilogGlobalLogger")]
public sealed class SidecarHostSupervisionTests
{
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(5);

    private sealed class BareHost : SidecarHost
    {
        public BareHost()
            : base("test") { }
    }

    [Fact]
    public async Task A_sidecar_whose_host_is_gone_fails_before_ready()
    {
        var endpoint = IpcConnection.GenerateSocketPath($"orphan-{Guid.NewGuid():N}");
        var gone = await StandInProcess.ExitedPidAsync().ConfigureAwait(true);

        var (stdout, stderr) = await CaptureConsoleAsync(
                async (_, _) =>
                {
                    var host = new BareHost();
                    await using (host.ConfigureAwait(false))
                    {
                        await host.RunAsync(new SidecarStartupOptions(endpoint, gone))
                            .WaitAsync(Bound)
                            .ConfigureAwait(true);
                        Assert.True(host.StartupFailed, "an orphaned sidecar must exit non-zero");
                    }
                }
            )
            .ConfigureAwait(true);

        Assert.DoesNotContain("READY", stdout, StringComparison.Ordinal);
        Assert.Contains("FATAL", stderr, StringComparison.Ordinal);
        Assert.Contains($"parent process {gone}", stderr, StringComparison.Ordinal);
        await AssertEndpointFreeAsync(endpoint).ConfigureAwait(true);
    }

    [Fact]
    public async Task A_supervised_sidecar_stops_cleanly_when_its_live_host_dies()
    {
        var endpoint = IpcConnection.GenerateSocketPath($"supervised-{Guid.NewGuid():N}");
        using var parent = StandInProcess.StartIdle();

        var (stdout, stderr) = await CaptureConsoleAsync(
                (stdout, _) => RunUntilHostDiesAsync(endpoint, parent, stdout)
            )
            .ConfigureAwait(true);

        Assert.Contains($"READY:{endpoint}", stdout, StringComparison.Ordinal);
        Assert.DoesNotContain("FATAL", stderr, StringComparison.Ordinal);
        Assert.True(parent.HasExited, "the stand-in host was killed");
        await AssertEndpointFreeAsync(endpoint).ConfigureAwait(true);
    }

    /// Serve under a live host, kill the host, and require the run to end
    /// on its own — a clean stop, not a startup failure.
    private static async Task RunUntilHostDiesAsync(
        string endpoint,
        Process parent,
        CapturedConsoleWriter stdout
    )
    {
        var host = new BareHost();
        await using (host.ConfigureAwait(false))
        {
            var run = host.RunAsync(new SidecarStartupOptions(endpoint, parent.Id));
            await WaitForReadyAsync(stdout).ConfigureAwait(true);
            Assert.False(run.IsCompleted, "a supervised sidecar serves while its host lives");

            parent.Kill();
            await run.WaitAsync(Bound).ConfigureAwait(true);
            Assert.False(host.StartupFailed, "host death after READY is a clean stop");
        }
    }

    /// Run <paramref name="body" /> with stdout and stderr captured; returns both.
    private static async Task<(string Out, string Err)> CaptureConsoleAsync(
        Func<CapturedConsoleWriter, CapturedConsoleWriter, Task> body
    )
    {
        using var stdout = new CapturedConsoleWriter();
        using var stderr = new CapturedConsoleWriter();
        var (originalOut, originalError) = (Console.Out, Console.Error);
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            await body(stdout, stderr).ConfigureAwait(true);
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
        }

        return (stdout.Snapshot(), stderr.Snapshot());
    }

    private static async Task WaitForReadyAsync(CapturedConsoleWriter stdout)
    {
        var deadline = Stopwatch.StartNew();
        while (!stdout.Snapshot().Contains("READY:", StringComparison.Ordinal))
        {
            Assert.True(deadline.Elapsed < Bound, "the supervised sidecar never printed READY");
            await Task.Delay(50).ConfigureAwait(true);
        }
    }

    /// Nothing holds the endpoint: a fresh listener can take it.
    private static async Task AssertEndpointFreeAsync(string endpoint)
    {
        var listener = IpcConnection.CreateListener(endpoint);
        Assert.False(listener.IsError, listener.Match(_ => string.Empty, e => e));
        await listener
            .Match(l => l, _ => throw new InvalidOperationException())
            .DisposeAsync()
            .ConfigureAwait(true);
    }
}
