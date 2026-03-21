using Outcome;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers .sln or .csproj files from a workspace root.
/// </summary>
internal static class SolutionLoader
{
    /// <summary>
    /// Find a solution or project file to open.
    /// Priority: explicit path > .sln in root > .csproj in root > recursive.
    /// </summary>
    public static Result<string?, string> FindSolutionOrProject(
        string workspacePath)
    {
        try
        {
            var result = FindExplicitOrRootMatch(workspacePath)
                ?? FindRecursiveMatch(workspacePath);
            return new Result<string?, string>.Ok<string?, string>(result);
        }
        catch (Exception ex)
        {
            return Result<string?, string>.Failure(ex.Message);
        }
    }

    private static string? FindExplicitOrRootMatch(string workspacePath)
    {
        return File.Exists(workspacePath)
            ? workspacePath
            : Directory.Exists(workspacePath)
                ? FindInRootDirectory(workspacePath)
                : null;
    }

    private static string? FindInRootDirectory(string workspacePath)
    {
        var slnFiles = Directory.GetFiles(
            workspacePath, "*.sln", SearchOption.TopDirectoryOnly);
        if (slnFiles.Length is 1)
        {
            return slnFiles[0];
        }

        if (slnFiles.Length > 1)
        {
            return PickBestSolution(slnFiles, workspacePath);
        }

        var csprojFiles = Directory.GetFiles(
            workspacePath, "*.csproj", SearchOption.TopDirectoryOnly);
        return csprojFiles.Length > 0 ? csprojFiles[0] : null;
    }

    private static string PickBestSolution(
        string[] slnFiles,
        string workspacePath)
    {
        var dirName = Path.GetFileName(workspacePath);
        var match = Array.Find(slnFiles, s =>
            string.Equals(
                Path.GetFileNameWithoutExtension(s),
                dirName,
                StringComparison.OrdinalIgnoreCase));
        return match ?? slnFiles[0];
    }

    private static string? FindRecursiveMatch(string workspacePath)
    {
        if (!Directory.Exists(workspacePath))
        {
            return null;
        }

        var slnFiles = Directory.GetFiles(
            workspacePath, "*.sln", SearchOption.AllDirectories);
        if (slnFiles.Length > 0)
        {
            return slnFiles[0];
        }

        var csprojFiles = Directory.GetFiles(
            workspacePath, "*.csproj", SearchOption.AllDirectories);
        return csprojFiles.Length > 0 ? csprojFiles[0] : null;
    }
}
