using Outcome;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers .sln, .slnx, or .csproj files from a workspace root.
/// </summary>
internal static class SolutionLoader
{
    public static Result<string?, string> FindSolutionOrProject(string workspacePath)
    {
        try
        {
            var result =
                FindExplicitOrRootMatch(workspacePath) ?? FindRecursiveMatch(workspacePath);
            return new Result<string?, string>.Ok<string?, string>(result);
        }
        catch (Exception ex)
        {
            return Result<string?, string>.Failure(ex.Message);
        }
    }

    // Only .sln/.slnx/.csproj are loadable targets. Returning any existing file here would
    // route a plain .cs or .csx document into MSBuildWorkspace.OpenProjectAsync, which fails —
    // and would prevent it ever reaching file-based/script loading. Implements [SCRIPT-DETECT].
    private static readonly string[] ProjectOrSolutionExtensions = [".sln", ".slnx", ".csproj"];

    internal static bool IsProjectOrSolutionFile(string path)
    {
        var extension = Path.GetExtension(path);
        return Array.Exists(
            ProjectOrSolutionExtensions,
            candidate => string.Equals(extension, candidate, StringComparison.OrdinalIgnoreCase)
        );
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
        var solutionFiles = EnumerateSolutionFiles(workspacePath, SearchOption.TopDirectoryOnly);
        if (solutionFiles.Length is 1)
        {
            return solutionFiles[0];
        }

        if (solutionFiles.Length > 1)
        {
            return PickBestSolution(solutionFiles, workspacePath);
        }

        var csprojFiles = Directory.GetFiles(
            workspacePath,
            "*.csproj",
            SearchOption.TopDirectoryOnly
        );
        return csprojFiles.Length > 0 ? csprojFiles[0] : null;
    }

    private static string PickBestSolution(string[] solutionFiles, string workspacePath)
    {
        var dirName = Path.GetFileName(workspacePath);
        var match = Array.Find(
            solutionFiles,
            s =>
                string.Equals(
                    Path.GetFileNameWithoutExtension(s),
                    dirName,
                    StringComparison.OrdinalIgnoreCase
                )
        );
        return match ?? solutionFiles[0];
    }

    /// <summary>
    /// The competing solutions under <paramref name="workspacePath"/> when recursive discovery
    /// found more than one and therefore returned no target. Empty when the root resolves
    /// unambiguously or holds no solution at all, which lets a caller tell AMBIGUITY apart from
    /// ABSENCE — <see cref="FindSolutionOrProject"/> reports both as a null target.
    /// Implements [SCRIPT-DEGRADE].
    /// </summary>
    internal static string[] FindAmbiguousSolutions(string workspacePath)
    {
        if (!Directory.Exists(workspacePath) || FindExplicitOrRootMatch(workspacePath) is not null)
        {
            return [];
        }

        var solutionFiles = EnumerateSolutionFiles(workspacePath, SearchOption.AllDirectories);
        return solutionFiles.Length > 1 ? solutionFiles : [];
    }

    private static string? FindRecursiveMatch(string workspacePath)
    {
        if (!Directory.Exists(workspacePath))
        {
            return null;
        }

        var solutionFiles = EnumerateSolutionFiles(workspacePath, SearchOption.AllDirectories);
        if (solutionFiles.Length is 1)
        {
            return solutionFiles[0];
        }

        // Multiple solution files: ambiguous. Return null so the caller can
        // ask the user to specify which solution to load.
        if (solutionFiles.Length > 1)
        {
            return null;
        }

        var csprojFiles = Directory.GetFiles(
            workspacePath,
            "*.csproj",
            SearchOption.AllDirectories
        );
        return csprojFiles.Length is 1 ? csprojFiles[0] : null;
    }

    // Enumerate both .sln and .slnx explicitly. The "*.sln" glob matches .slnx
    // on Windows (8.3 short-name behavior) but not on macOS/Linux, so a single
    // pattern is not portable.
    private static string[] EnumerateSolutionFiles(string path, SearchOption option)
    {
        var sln = Directory.GetFiles(path, "*.sln", option);
        var slnx = Directory.GetFiles(path, "*.slnx", option);
        if (sln.Length == 0)
        {
            return slnx;
        }
        if (slnx.Length == 0)
        {
            return sln;
        }
        var combined = new string[sln.Length + slnx.Length];
        Array.Copy(sln, combined, sln.Length);
        Array.Copy(slnx, 0, combined, sln.Length, slnx.Length);
        return combined;
    }
}
