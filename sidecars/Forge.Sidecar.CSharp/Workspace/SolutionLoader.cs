using Outcome;

namespace Forge.Sidecar.CSharp.Workspace;

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

    private static string? FindExplicitOrRootMatch(string workspacePath)
    {
        return File.Exists(workspacePath) ? workspacePath
            : Directory.Exists(workspacePath) ? FindInRootDirectory(workspacePath)
            : null;
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
