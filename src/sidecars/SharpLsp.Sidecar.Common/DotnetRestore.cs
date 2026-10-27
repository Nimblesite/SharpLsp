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
    private static readonly TimeSpan DefaultStageLimit = TimeSpan.FromMinutes(2);

    /// <summary>
    /// The project at <paramref name="projectPath"/> restored, with
    /// <paramref name="properties"/> set; a failure carries what the restore printed.
    /// </summary>
    public static Task<RestoreResult> RunAsync(
        string projectPath,
        string workingDirectory,
        IReadOnlyDictionary<string, string> properties,
        CancellationToken ct
    )
    {
        return RunAsync(projectPath, workingDirectory, properties, DefaultStageLimit, ct);
    }

    /// <summary>Test-only hook: the bound on one restore or evaluate stage.</summary>
    internal static async Task<RestoreResult> RunAsync(
        string projectPath,
        string workingDirectory,
        IReadOnlyDictionary<string, string> properties,
        TimeSpan stageLimit,
        CancellationToken ct
    )
    {
        var restored = await RunStageAsync(
                projectPath,
                workingDirectory,
                properties,
                false,
                stageLimit,
                ct
            )
            .ConfigureAwait(false);
        return restored.IsError
            ? restored
            : await RunStageAsync(projectPath, workingDirectory, properties, true, stageLimit, ct)
                .ConfigureAwait(false);
    }

    private static Task<RestoreResult> RunStageAsync(
        string project,
        string directory,
        IReadOnlyDictionary<string, string> properties,
        bool evaluate,
        TimeSpan limit,
        CancellationToken ct
    )
    {
        var stage = evaluate ? "evaluate" : "restore";
        var arguments = CommandArguments(project, evaluate)
            .Concat(properties.Select(property => $"-p:{property.Key}={property.Value}"));
        return RunProcessAsync(StartInfo(directory, arguments), project, stage, limit, ct);
    }

    private static async Task<RestoreResult> RunProcessAsync(
        ProcessStartInfo info,
        string project,
        string stage,
        TimeSpan limit,
        CancellationToken ct
    )
    {
        using var process = Process.Start(info);
        if (process is null)
        {
            return RestoreResult.Failure("Could not start `dotnet restore`.");
        }
        // Restore never asks a question, so close its input: a child that reads stdin
        // would otherwise block forever on the sidecar's own stream. [DIAG-RESTORE]
        process.StandardInput.Close();
        return await CompleteProcessAsync(process, project, stage, limit, ct).ConfigureAwait(false);
    }

    private static async Task<RestoreResult> CompleteProcessAsync(
        Process process,
        string project,
        string stage,
        TimeSpan limit,
        CancellationToken ct
    )
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(limit);
        var standardOutput = ReadToEndBoundedAsync(process.StandardOutput, timeout.Token);
        var standardError = ReadToEndBoundedAsync(process.StandardError, timeout.Token);

        try
        {
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            var detail = await DetailAsync(standardOutput, standardError).ConfigureAwait(false);
            return process.ExitCode == 0
                ? new RestoreResult.Ok<Unit, string>(Unit.Value)
                : RestoreResult.Failure(detail);
        }
        catch (OperationCanceledException)
        {
            KillProcessTree(process);
            // Observe the reads so a cancelled pipe read is never an unobserved fault.
            _ = await DetailAsync(standardOutput, standardError).ConfigureAwait(false);
            if (ct.IsCancellationRequested)
            {
                throw;
            }
            return Overran(project, stage, limit);
        }
    }

    private static RestoreResult Overran(string project, string stage, TimeSpan limit)
    {
        var seconds = (int)limit.TotalSeconds;
        Log.Warning(
            "Restore {Stage} for {Project} did not finish within {Seconds} seconds",
            stage,
            project,
            seconds
        );
        return RestoreResult.Failure($"{stage} did not finish within {seconds} seconds");
    }

    private static ProcessStartInfo StartInfo(string directory, IEnumerable<string> arguments)
    {
        var startInfo = DotnetProcess.StartInfo(directory);
        startInfo.RedirectStandardInput = true;
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
            ?
            [
                "msbuild",
                project,
                "-getProperty:TargetFramework",
                "-verbosity:quiet",
                "-nodeReuse:false",
            ]
            : ["restore", "--disable-build-servers", project, "--verbosity", "quiet"];
    }

    private static async Task<string> ReadToEndBoundedAsync(
        StreamReader reader,
        CancellationToken ct
    )
    {
        try
        {
            return await reader.ReadToEndAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return string.Empty;
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
