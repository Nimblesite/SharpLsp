using System.Diagnostics;

#pragma warning disable RS1035 // Real-process use is intentional: fixtures are built for real

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Builds a fixture project with the dotnet CLI, in Debug: MSBuildWorkspace opens projects
/// under MSBuild's default configuration, so Debug is where it looks for a cross-language
/// reference's DLL.
/// </summary>
internal static class DotnetBuild
{
    /// <summary>
    /// Build <paramref name="project"/> and its project references, returning the exit code
    /// and merged output. Build servers are off: on Linux an MSBuild node kept for reuse
    /// inherits the redirected pipes and outlives the build, so its output never ends and
    /// reading it never returns — a multi-targeted project builds on such a node.
    /// </summary>
    public static (int ExitCode, string Output) Run(string project)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "build",
                project,
                "--configuration",
                "Debug",
                "--nologo",
                "--disable-build-servers",
            },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var build =
            Process.Start(startInfo) ?? throw new InvalidOperationException("dotnet did not start");
        // Drain both pipes at once: reading them in turn deadlocks once the unread one fills.
        var stderr = build.StandardError.ReadToEndAsync();
        var stdout = build.StandardOutput.ReadToEnd();
        build.WaitForExit();
        return (build.ExitCode, stdout + stderr.GetAwaiter().GetResult());
    }
}
