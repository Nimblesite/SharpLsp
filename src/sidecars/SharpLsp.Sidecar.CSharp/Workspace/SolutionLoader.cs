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
    internal sealed record Discovery(string? Target, string[] Competing)
    {
        /// <summary>All standalone projects found by the same workspace walk.</summary>
        internal string[] Projects { get; init; } = [];
    }

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
    /// from ONE walk of the tree. A solution the walk picks does not hide the standalone
    /// projects it met: they are reported beside it and load with it (#575). Implements
    /// [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY] and [SCRIPT-DEGRADE].
    /// </summary>
    internal static Result<Discovery, string> Discover(string workspacePath)
    {
        try
        {
            var discovery = File.Exists(workspacePath)
                ? new Discovery(ExplicitFileTarget(workspacePath), [])
                : FindFromWalk(workspacePath);
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

    private static string? ExplicitFileTarget(string workspacePath)
    {
        return IsProjectOrSolutionFile(workspacePath) ? workspacePath : null;
    }

    private static string PickBestSolution(string[] solutionFiles, string workspacePath)
    {
        var dirName = NativePaths.NameOf(workspacePath);
        var match = Array.Find(solutionFiles, s =>
            string.Equals(NativePaths.StemOf(s), dirName, NativePaths.Comparison)
        );
        return match ?? solutionFiles[0];
    }

    /// <summary>
    /// One recursive walk of a directory. What sits in the directory itself wins: a
    /// solution there (the best-named of several), else a project there, whatever is
    /// nested beneath. Otherwise a sole nested solution is the target, several compete
    /// and none is guessed, and with no solution the first project is. Whatever it picks,
    /// every project file the walk met is reported, so the standalone projects beside the
    /// target can load too (#575). Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
    /// </summary>
    private static Discovery FindFromWalk(string workspacePath)
    {
        if (!Directory.Exists(workspacePath))
        {
            return new Discovery(null, []);
        }

        var found = NativePaths.WorkspaceFiles(workspacePath, ProjectOrSolutionExtensions);
        var solutionFiles = Array.FindAll(found, IsSolution);
        var projectFiles = Array.FindAll(found, path => !IsSolution(path));
        var target = RootTarget(workspacePath, solutionFiles, projectFiles)
            ?? solutionFiles.Length switch
            {
                1 => solutionFiles[0],
                > 1 => null,
                _ => projectFiles.FirstOrDefault(),
            };
        return new Discovery(target, target is null ? solutionFiles : [])
        {
            Projects = projectFiles,
        };
    }

    /// <summary>What sits in the opened directory itself: its best-named solution, else
    /// its project. Nothing nested competes with it.</summary>
    private static string? RootTarget(
        string workspacePath,
        string[] solutionFiles,
        string[] projectFiles
    )
    {
        var rootSolutions = Array.FindAll(solutionFiles, s => SitsInRoot(workspacePath, s));
        return rootSolutions.Length > 0
            ? PickBestSolution(rootSolutions, workspacePath)
            : Array.Find(projectFiles, project => SitsInRoot(workspacePath, project));
    }

    /// <summary>
    /// The <paramref name="walked"/> projects that load beside a solution listing
    /// <paramref name="listed"/>: its unlisted siblings. A project nested inside a listed
    /// project's own directory is that project's fixture or sample, not a sibling the
    /// solution hid, so it waits for one of its files to be opened
    /// ([SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING]).
    /// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
    /// </summary>
    internal static List<string> Siblings(
        IReadOnlyList<string> walked,
        IReadOnlyList<string> listed
    )
    {
        var owned = listed.Select(NativePaths.DirectoryOf).ToList();
        return
        [
            .. walked
                .Except(listed, NativePaths.Comparer)
                .Where(project => !owned.Exists(dir => NativePaths.IsWithin(dir, project))),
        ];
    }

    /// <summary>Whether <paramref name="file"/> sits directly in <paramref name="root"/>.</summary>
    private static bool SitsInRoot(string root, string file)
    {
        return NativePaths.AreEqual(
            NativePaths.AsDirectory(NativePaths.DirectoryOf(file)),
            NativePaths.AsDirectory(root)
        );
    }
}
