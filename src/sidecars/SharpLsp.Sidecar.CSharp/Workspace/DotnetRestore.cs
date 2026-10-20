using System.Diagnostics;
using Outcome;
using Serilog;
using SharpLsp.Sidecar.Common;
using RestoreResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Runs <c>dotnet restore</c> on one project: a file-based app's generated project, or a
/// project that owns a file and was never restored. Implements [DIAG-RESTORE].
/// </summary>
internal static class DotnetRestore
{
    private static readonly TimeSpan KillWait = TimeSpan.FromSeconds(10);

    /// <summary>
    /// The project at <paramref name="projectPath"/> restored, with
    /// <paramref name="properties"/> set; a failure carries what the restore printed.
    /// </summary>
    internal static async Task<RestoreResult> RunAsync(
        string projectPath,
        string workingDirectory,
        IReadOnlyDictionary<string, string> properties,
        CancellationToken ct
    )
    {
        using var process = Process.Start(StartInfo(projectPath, workingDirectory, properties));
        if (process is null)
        {
            return RestoreResult.Failure("Could not start `dotnet restore`.");
        }

        var standardOutput = process.StandardOutput.ReadToEndAsync(ct);
        var standardError = process.StandardError.ReadToEndAsync(ct);
        await WaitForExitAsync(process, ct).ConfigureAwait(false);
        var detail = await DetailAsync(standardOutput, standardError).ConfigureAwait(false);
        return process.ExitCode == 0
            ? new RestoreResult.Ok<Unit, string>(Unit.Value)
            : RestoreResult.Failure(detail);
    }

    /// <summary>
    /// <paramref name="project"/> restored when it has no <c>obj/project.assets.json</c>, as a
    /// fresh clone leaves it; until then its PackageReferences, NETStandard.Library among
    /// them, give Roslyn no references. Logs the outcome; never throws.
    /// </summary>
    internal static async Task RestoreWhenMissingAsync(string project, CancellationToken ct)
    {
        var assets = NativePaths.Join(
            NativePaths.DirectoryOf(project),
            "obj",
            "project.assets.json"
        );
        if (File.Exists(assets))
        {
            return;
        }

        Log.Information("C# restoring {Project}: it has no assets file", project);
        var restored = await RunAsync(
                project,
                NativePaths.DirectoryOf(project),
                new Dictionary<string, string>(),
                ct
            )
            .ConfigureAwait(false);
        if (restored is RestoreResult.Error<Unit, string> { Value: var detail })
        {
            Log.Warning("C# could not restore {Project}: {Detail}", project, detail);
            return;
        }
        Log.Information("C# restored {Project}", project);
    }

    private static ProcessStartInfo StartInfo(
        string projectPath,
        string workingDirectory,
        IReadOnlyDictionary<string, string> properties
    )
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("restore");
        startInfo.ArgumentList.Add(projectPath);
        startInfo.ArgumentList.Add("--verbosity");
        startInfo.ArgumentList.Add("quiet");
        foreach (var (name, value) in properties)
        {
            startInfo.ArgumentList.Add($"-p:{name}={value}");
        }
        return startInfo;
    }

    private static async Task WaitForExitAsync(Process process, CancellationToken ct)
    {
        try
        {
            await process.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            KillProcessTree(process);
            throw;
        }
    }

    private static void KillProcessTree(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            // Kill only STARTS termination. Until the restore has exited it still stands in the
            // app's folder, which Windows refuses to delete. [SCRIPT-LIFECYCLE]
            _ = process.WaitForExit(KillWait);
        }
        catch (Exception exception)
        {
            Log.Debug(exception, "Could not terminate cancelled package restore");
        }
    }

    private static async Task<string> DetailAsync(
        Task<string> standardOutput,
        Task<string> standardError
    )
    {
        var error = (await standardError.ConfigureAwait(false)).Trim();
        var output = (await standardOutput.ConfigureAwait(false)).Trim();
        return error.Length > 0 ? error
            : output.Length > 0 ? output
            : "no output";
    }
}
