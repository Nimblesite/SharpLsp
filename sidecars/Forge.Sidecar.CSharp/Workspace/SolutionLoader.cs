namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers .sln or .csproj files from a workspace root.
/// </summary>
public static class SolutionLoader
{
    /// <summary>
    /// Find a solution or project file to open.
    /// Priority: explicit path > .sln in root > .csproj in root > recursive search.
    /// </summary>
    public static string? FindSolutionOrProject(string workspacePath)
    {
        if (File.Exists(workspacePath))
        {
            return workspacePath;
        }

        if (!Directory.Exists(workspacePath))
        {
            return null;
        }

        var slnFiles = Directory.GetFiles(workspacePath, "*.sln", SearchOption.TopDirectoryOnly);
        if (slnFiles.Length is 1)
        {
            return slnFiles[0];
        }

        if (slnFiles.Length > 1)
        {
            // Multiple .sln files — pick the one matching the directory name, or first.
            var dirName = Path.GetFileName(workspacePath);
            var match = Array.Find(slnFiles, s =>
                string.Equals(
                    Path.GetFileNameWithoutExtension(s),
                    dirName,
                    StringComparison.OrdinalIgnoreCase));
            return match ?? slnFiles[0];
        }

        var csprojFiles = Directory.GetFiles(workspacePath, "*.csproj", SearchOption.TopDirectoryOnly);
        if (csprojFiles.Length > 0)
        {
            return csprojFiles[0];
        }

        // Recursive fallback.
        var recursiveSln = Directory.GetFiles(workspacePath, "*.sln", SearchOption.AllDirectories);
        if (recursiveSln.Length > 0)
        {
            return recursiveSln[0];
        }

        var recursiveCsproj = Directory.GetFiles(workspacePath, "*.csproj", SearchOption.AllDirectories);
        return recursiveCsproj.Length > 0 ? recursiveCsproj[0] : null;
    }
}
