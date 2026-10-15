using SharpLsp.Sidecar.Common.Ipc;

#pragma warning disable RS1035 // Console capture is intentional: READY and FATAL are the host-visible contract

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A supervised sidecar whose host is already gone fails before READY and
/// binds nothing — it must not squat an endpoint for a host that will never
/// connect. Implements [SIDECAR-PROCESS-PARENT] and [SIDECAR-STARTUP-FAILURE] (GitHub #163).
///
/// Shares the <c>SerilogGlobalLogger</c> collection: the host swaps the
/// process-global logger.
/// </summary>
[Collection("SerilogGlobalLogger")]
public sealed class SidecarHostSupervisionTests
{
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
        using var stdout = new CapturedConsoleWriter();
        using var stderr = new CapturedConsoleWriter();
        var (originalOut, originalError) = (Console.Out, Console.Error);
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var host = new BareHost();
            await using (host.ConfigureAwait(false))
            {
                await host.RunAsync(new SidecarStartupOptions(endpoint, gone))
                    .WaitAsync(TimeSpan.FromSeconds(5))
                    .ConfigureAwait(true);
                Assert.True(host.StartupFailed, "an orphaned sidecar must exit non-zero");
            }
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
        }

        Assert.DoesNotContain("READY", stdout.Snapshot(), StringComparison.Ordinal);
        Assert.Contains("FATAL", stderr.Snapshot(), StringComparison.Ordinal);
        Assert.Contains($"parent process {gone}", stderr.Snapshot(), StringComparison.Ordinal);
        await AssertEndpointFreeAsync(endpoint).ConfigureAwait(true);
    }

    /// Nothing bound the endpoint: a fresh listener can take it.
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
