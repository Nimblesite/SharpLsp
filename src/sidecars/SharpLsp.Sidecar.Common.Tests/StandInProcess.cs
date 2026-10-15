using System.Diagnostics;

#pragma warning disable RS1035 // Real-process use is intentional: supervision is proven against real processes

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A real, idle, separately spawned process the supervision tests can watch,
/// contain and kill — standing in for the host (or a sidecar) without
/// touching the test runner itself.
/// </summary>
internal static class StandInProcess
{
    private static readonly TimeSpan ExitBound = TimeSpan.FromSeconds(10);

    /// <summary>Start a process that idles for a minute unless killed.</summary>
    public static Process StartIdle()
    {
        var info = OperatingSystem.IsWindows()
            ? new ProcessStartInfo("ping", "-n 60 127.0.0.1")
            : new ProcessStartInfo("sleep", "60");
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.CreateNoWindow = true;
        return Process.Start(info) ?? throw new InvalidOperationException("stand-in did not start");
    }

    /// <summary>The PID of a process that has already exited.</summary>
    public static async Task<int> ExitedPidAsync()
    {
        using var process = StartIdle();
        var pid = process.Id;
        process.Kill();
        await process.WaitForExitAsync().ConfigureAwait(false);
        return pid;
    }

    /// <summary>Whether <paramref name="pid" /> exits within the bound.</summary>
    public static async Task<bool> ExitsWithinBoundAsync(int pid)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < ExitBound)
        {
            if (!IsRunning(pid))
            {
                return true;
            }

            await Task.Delay(100).ConfigureAwait(false);
        }

        return false;
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
