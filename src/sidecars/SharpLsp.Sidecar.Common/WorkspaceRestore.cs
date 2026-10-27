using Serilog;
using SharpLsp.Sidecar.Common.Solutions;
using RestoreResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.Common;

/// <summary>Restore stale SDK inputs before compiler workspace creation. [DIAG-RESTORE]</summary>
public static class WorkspaceRestore
{
    /// <summary>Restore the C# projects in an explicitly selected SDK project or solution.</summary>
    public static async Task<RestoreResult> EnsureTargetAsync(string target, CancellationToken ct)
    {
        if (!SolutionFileReader.IsSolutionFile(target))
        {
            return await EnsureProjectsAsync([target], ct).ConfigureAwait(false);
        }
        var read = await SolutionFileReader.ReadAsync(target, ct).ConfigureAwait(false);
        return read.IsError
            ? RestoreResult.Failure(!read ?? "Could not read the selected solution.")
            : await EnsureProjectsAsync(CSharpProjects(+read), ct).ConfigureAwait(false);
    }

    private static IEnumerable<string> CSharpProjects(SolutionFileModel solution)
    {
        return solution
            .Projects.Where(project => NativePaths.HasExtension(project.Path, ".csproj"))
            .Select(project => project.Path);
    }

    /// <summary>Only explicitly opened workspaces opt into this gate; owning-file loads keep their contract.</summary>
    public static async Task<RestoreResult> EnsureProjectsAsync(
        IEnumerable<string> projects,
        CancellationToken ct
    )
    {
        try
        {
            return await RestoreProjectsAsync(projects, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            return RestoreResult.Failure(
                "Could not inspect workspace restore inputs; run dotnet restore manually."
            );
        }
    }

    private static async Task<RestoreResult> RestoreProjectsAsync(
        IEnumerable<string> projects,
        CancellationToken ct
    )
    {
        foreach (var project in projects)
        {
            var result = await EnsureProjectAsync(project, ct).ConfigureAwait(false);
            if (result.IsError)
            {
                return result;
            }
        }
        return new RestoreResult.Ok<Outcome.Unit, string>(Outcome.Unit.Value);
    }

    private static async Task<RestoreResult> EnsureProjectAsync(
        string project,
        CancellationToken ct
    )
    {
        if (AssetsCurrent(project))
        {
            return new RestoreResult.Ok<Outcome.Unit, string>(Outcome.Unit.Value);
        }
        Log.Information("Restoring stale workspace inputs for {Project}", project);
        var result = await DotnetRestore
            .RunAsync(
                project,
                NativePaths.DirectoryOf(project),
                new Dictionary<string, string>(),
                ct
            )
            .ConfigureAwait(false);
        return CompletedRestore(project, result);
    }

    private static bool AssetsCurrent(string project)
    {
        var assets = NativePaths.Resolve(
            NativePaths.DirectoryOf(project),
            "obj",
            "project.assets.json"
        );
        var packages = PackageAssets.MissingPackages(project);
        if (packages.IsError)
        {
            // NuGet's no-op cache skips corrupt assets; discard only its unreadable output.
            File.Delete(assets);
            return false;
        }
        return File.Exists(assets)
            && File.GetLastWriteTimeUtc(project) <= File.GetLastWriteTimeUtc(assets)
            && WorkspaceRestoreInputs.AreCurrent(project, File.GetLastWriteTimeUtc(assets))
            && packages.Match(missing => missing.Length == 0, _ => false);
    }

    private static RestoreResult CompletedRestore(string project, RestoreResult result)
    {
        Log.Information(
            "Workspace restore completed for {Project}; succeeded {Succeeded}",
            project,
            result.IsOk
        );
        if (result.IsOk)
        {
            return RememberedRestore(project, result);
        }
        Log.Warning(
            "Package restore failed for {Project}: {Detail}",
            project,
            result.Match(_ => string.Empty, detail => detail)
        );
        return RestoreResult.Failure(
            $"Package restore failed for {project}; run dotnet restore manually."
        );
    }

    private static RestoreResult RememberedRestore(string project, RestoreResult result)
    {
        // Successful SDK evaluation proves the complete surviving graph. [DIAG-RESTORE]
        WorkspaceRestoreProof.Record(project);
        return result;
    }
}
