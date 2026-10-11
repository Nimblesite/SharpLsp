using Outcome;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers .sln, .slnx, or .csproj files from a workspace root.
/// </summary>
internal static class SolutionLoader
{
    /// <summary>
    /// What discovery found under a path: the target to load, or — when several solutions
    /// compete and discovery refused to guess — every competitor. Neither means ABSENCE.
    /// </summary>
    internal sealed record Discovery(string? Target, string[] Competing);

    public static Result<string?, string> FindSolutionOrProject(string workspacePath)
    {
        return Discover(workspacePath)
            .Match(
                found => new Result<string?, string>.Ok<string?, string>(found.Target),
                Result<string?, string>.Failure
            );
    }

    /// <summary>
    /// The target under <paramref name="workspacePath"/>, or the solutions competing for it,
    /// from ONE walk of the tree. Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY] and
    /// [SCRIPT-DEGRADE].
    /// </summary>
    internal static Result<Discovery, string> Discover(string workspacePath)
    {
        try
        {
            var discovery = FindExplicitOrRootMatch(workspacePath) is { } match
                ? new Discovery(match, [])
                : FindRecursiveMatch(workspacePath);
            return new Result<Discovery, string>.Ok<Discovery, string>(discovery);
        }
        catch (Exception ex)
        {
            return Result<Discovery, string>.Failure(ex.Message);
        }
    }

    // Only .sln/.slnx/.csproj are loadable targets. Returning any existing file here would
    // route a plain .cs or .csx document into MSBuildWorkspace.OpenProjectAsync, which fails —
    // and would prevent it ever reaching file-based/script loading. Implements [SCRIPT-DETECT].
    private static readonly string[] ProjectOrSolutionExtensions = [".sln", ".slnx", ".csproj"];

    private static readonly string[] SolutionExtensions = [".sln", ".slnx"];

    internal static bool IsProjectOrSolutionFile(string path)
    {
        return HasAnyExtension(path, ProjectOrSolutionExtensions);
    }

    private static bool IsSolution(string path)
    {
        return HasAnyExtension(path, SolutionExtensions);
    }

    private static bool HasAnyExtension(string path, string[] extensions)
    {
        return Array.Exists(extensions, candidate => NativePaths.HasExtension(path, candidate));
    }

    private static string? FindExplicitOrRootMatch(string workspacePath)
    {
        return File.Exists(workspacePath) ? ExplicitFileTarget(workspacePath)
            : Directory.Exists(workspacePath) ? FindInRootDirectory(workspacePath)
            : null;
    }

    private static string? ExplicitFileTarget(string workspacePath)
    {
        return IsProjectOrSolutionFile(workspacePath) ? workspacePath : null;
    }

    private static string? FindInRootDirectory(string workspacePath)
    {
        var rootFiles = Directory.GetFiles(workspacePath);
        var solutionFiles = Array.FindAll(rootFiles, IsSolution);
        return solutionFiles.Length switch
        {
            1 => solutionFiles[0],
            > 1 => PickBestSolution(solutionFiles, workspacePath),
            _ => Array.Find(rootFiles, path => NativePaths.HasExtension(path, ".csproj")),
        };
    }

    private static string PickBestSolution(string[] solutionFiles, string workspacePath)
    {
        var dirName = NativePaths.NameOf(workspacePath);
        var match = Array.Find(
            solutionFiles,
            s => NativePaths.Comparer.Equals(NativePaths.StemOf(s), dirName)
        );
        return match ?? solutionFiles[0];
    }

    /// <summary>
    /// One solution nested anywhere is the target; several compete and none is guessed, so
    /// the caller can ask which to load; with none, a lone nested project is the target.
    /// </summary>
    private static Discovery FindRecursiveMatch(string workspacePath)
    {
        if (!Directory.Exists(workspacePath))
        {
            return new Discovery(null, []);
        }

        var found = NativePaths.WorkspaceFiles(workspacePath, ProjectOrSolutionExtensions);
        var solutionFiles = Array.FindAll(found, IsSolution);
        var projectFiles = Array.FindAll(found, path => !IsSolution(path));
        return solutionFiles.Length switch
        {
            1 => new Discovery(solutionFiles[0], []),
            > 1 => new Discovery(null, solutionFiles),
            _ => new Discovery(projectFiles.Length is 1 ? projectFiles[0] : null, []),
        };
    }
}
