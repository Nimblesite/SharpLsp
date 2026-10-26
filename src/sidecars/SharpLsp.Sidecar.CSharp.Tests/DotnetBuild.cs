using System.Diagnostics;

#pragma warning disable RS1035 // Real-process use is intentional: fixtures are built for real

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Runs the dotnet CLI for fixture projects: <c>build</c> in Debug — MSBuildWorkspace opens
/// projects under MSBuild's default configuration, so Debug is where it looks for a
/// cross-language reference's DLL — and <c>restore</c> for real NuGet package resolution.
/// </summary>
internal static class DotnetBuild
{
    /// <summary>
    /// Build <paramref name="project"/> and its project references, with any extra
    /// <paramref name="arguments"/> such as a framework, returning the exit code
    /// and merged output. Build servers are off: on Linux an MSBuild node kept for reuse
    /// inherits the redirected pipes and outlives the build, so its output never ends and
    /// reading it never returns — a multi-targeted project builds on such a node.
    /// </summary>
    public static (int ExitCode, string Output) Run(string project, params string[] arguments)
    {
        return RunDotnet([
            "build",
            project,
            "--configuration",
            "Debug",
            "--nologo",
            "--disable-build-servers",
            .. arguments,
        ]);
    }

    /// <summary>Restore <paramref name="project"/>'s NuGet packages — real resolution, real cache.</summary>
    public static (int ExitCode, string Output) Restore(string project)
    {
        return RunDotnet(["restore", project, "--verbosity", "quiet"]);
    }

    private static (int ExitCode, string Output) RunDotnet(IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        using var build =
            Process.Start(startInfo) ?? throw new InvalidOperationException("dotnet did not start");
        // Drain both pipes at once: reading them in turn deadlocks once the unread one fills.
        var stderr = build.StandardError.ReadToEndAsync();
        var stdout = build.StandardOutput.ReadToEnd();
        build.WaitForExit();
        return (build.ExitCode, stdout + stderr.GetAwaiter().GetResult());
    }
}
