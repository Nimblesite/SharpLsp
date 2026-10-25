using System.Diagnostics;
using Outcome;
using Serilog;
using RestoreResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Runs <c>dotnet restore</c> on one project, such as a file-based app's generated project.
/// Implements [DIAG-RESTORE].
/// </summary>
public static class DotnetRestore
{
    private static readonly TimeSpan KillWait = TimeSpan.FromSeconds(10);

    /// <summary>
    /// The project at <paramref name="projectPath"/> restored, with
    /// <paramref name="properties"/> set; a failure carries what the restore printed.
    /// </summary>
    public static async Task<RestoreResult> RunAsync(
        string projectPath,
        string workingDirectory,
        IReadOnlyDictionary<string, string> properties,
        CancellationToken ct
    )
    {
        var restored = await RunStageAsync(projectPath, workingDirectory, properties, false, ct)
            .ConfigureAwait(false);
        return restored.IsError
            ? restored
            : await RunStageAsync(projectPath, workingDirectory, properties, true, ct)
                .ConfigureAwait(false);
    }

    private static Task<RestoreResult> RunStageAsync(
        string project,
        string directory,
        IReadOnlyDictionary<string, string> properties,
        bool evaluate,
        CancellationToken ct
    )
    {
        var arguments = CommandArguments(project, evaluate)
            .Concat(properties.Select(property => $"-p:{property.Key}={property.Value}"));
        return RunProcessAsync(StartInfo(directory, arguments), ct);
    }

    private static async Task<RestoreResult> RunProcessAsync(
        ProcessStartInfo info,
        CancellationToken ct
    )
    {
        using var process = Process.Start(info);
        return process is null
            ? RestoreResult.Failure("Could not start `dotnet restore`.")
            : await CompleteProcessAsync(process, ct).ConfigureAwait(false);
    }

    private static async Task<RestoreResult> CompleteProcessAsync(
        Process process,
        CancellationToken ct
    )
    {
        var standardOutput = process.StandardOutput.ReadToEndAsync(ct);
        var standardError = process.StandardError.ReadToEndAsync(ct);
        await WaitForExitAsync(process, ct).ConfigureAwait(false);
        var detail = await DetailAsync(standardOutput, standardError).ConfigureAwait(false);
        return process.ExitCode == 0
            ? new RestoreResult.Ok<Unit, string>(Unit.Value)
            : RestoreResult.Failure(detail);
    }

    private static ProcessStartInfo StartInfo(string directory, IEnumerable<string> arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = directory,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }

    private static string[] CommandArguments(string project, bool evaluate)
    {
        // Restore permits unresolved imports; normal SDK evaluation must succeed too. [DIAG-RESTORE]
        return evaluate
            ? ["msbuild", project, "-getProperty:TargetFramework", "-verbosity:quiet"]
            : ["restore", "--disable-build-servers", project, "--verbosity", "quiet"];
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
