using System.Diagnostics;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// The <c>ProcessStartInfo</c> for a <c>dotnet</c> child that resolves its own SDK.
/// Implements [DIAG-RESTORE].
/// </summary>
public static class DotnetProcess
{
    private static readonly string[] MsBuildRegistrationVariables =
    [
        "MSBUILD_EXE_PATH",
        "MSBuildExtensionsPath",
        "MSBuildSDKsPath",
    ];

    /// <summary>
    /// A <c>dotnet</c> child rooted at <paramref name="workingDirectory"/>, streaming
    /// stdout and stderr, with the host's MSBuild registration variables removed from
    /// its environment. The child then resolves the SDK the way the CLI would — its
    /// <c>global.json</c>, else the newest installed — instead of inheriting the SDK the
    /// host registered for its in-process MSBuild.
    /// </summary>
    public static ProcessStartInfo StartInfo(string workingDirectory)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // ProcessStartInfo.Environment is copied lazily from this process on first
        // access, so each variable must be removed after that copy exists.
        foreach (var variable in MsBuildRegistrationVariables)
        {
            _ = startInfo.Environment.Remove(variable);
        }
        return startInfo;
    }
}
