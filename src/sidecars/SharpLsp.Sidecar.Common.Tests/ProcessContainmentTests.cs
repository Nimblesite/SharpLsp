using System.Diagnostics;
using System.Globalization;
using SharpLsp.Sidecar.Common.Supervision;

#pragma warning disable RS1035 // Real-process use is intentional: supervision is proven against real processes

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Kill-on-close containment against a real process tree: a stand-in
/// sidecar that starts its own child (as Roslyn starts BuildHost) after it
/// joined the job. Implements [SIDECAR-PROCESS-TREE] (GitHub #163).
/// </summary>
public sealed class ProcessContainmentTests
{
    /// Waits for a go line on stdin, so the child starts only once the parent
    /// is contained, then prints the child's PID and idles.
    private const string SpawnChildScript =
        "$null = [Console]::In.ReadLine(); "
        + "$c = Start-Process ping -ArgumentList '-n','60','127.0.0.1' -PassThru -WindowStyle Hidden; "
        + "[Console]::Out.WriteLine($c.Id); Start-Sleep 60";

    [Fact]
    public async Task Closing_the_job_kills_the_contained_process_and_its_descendants()
    {
        if (!OperatingSystem.IsWindows())
        {
            return; // Job Objects are Windows containment; Unix uses process groups.
        }

        using var sidecar = StartSpawner();
        var containment = Contained(sidecar);
        Assert.True(containment.IsJobBacked);

        await sidecar.StandardInput.WriteLineAsync("go").ConfigureAwait(true);
        var childPid = int.Parse(
            await ReadChildPidAsync(sidecar).ConfigureAwait(true),
            CultureInfo.InvariantCulture
        );
        Assert.NotEqual(sidecar.Id, childPid);
        Assert.False(sidecar.HasExited, "the contained sidecar runs until the job closes");

        containment.Dispose();

        Assert.True(await StandInProcess.ExitsWithinBoundAsync(sidecar.Id).ConfigureAwait(true));
        Assert.True(
            await StandInProcess.ExitsWithinBoundAsync(childPid).ConfigureAwait(true),
            "a descendant started after containment must die with the job"
        );
    }

    [Fact]
    public void Containment_off_Windows_is_owned_by_the_host_process_group()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // Containing the test runner itself would kill it on handle close.
        }

        var result = ProcessContainment.ContainCurrentProcess();
        Assert.False(result.IsError);
        using var containment = result.Match(c => c, _ => throw new InvalidOperationException());
        Assert.False(containment.IsJobBacked);
    }

    private static ProcessContainment Contained(Process process)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException();
        }

        var result = ProcessContainment.Contain(process.SafeHandle);
        Assert.False(result.IsError, result.Match(_ => string.Empty, e => e));
        return result.Match(c => c, _ => throw new InvalidOperationException());
    }

    private static Process StartSpawner()
    {
        var info = new ProcessStartInfo("powershell", ["-NoProfile", "-Command", SpawnChildScript])
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
        };
        return Process.Start(info) ?? throw new InvalidOperationException("spawner did not start");
    }

    private static async Task<string> ReadChildPidAsync(Process spawner)
    {
        var line = await spawner
            .StandardOutput.ReadLineAsync()
            .WaitAsync(TimeSpan.FromSeconds(30))
            .ConfigureAwait(true);
        return line?.Trim() ?? throw new InvalidOperationException("spawner printed no child PID");
    }
}
