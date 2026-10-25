namespace SharpLsp.Sidecar.Common;

public static partial class NativePaths
{
    /// <summary>The SDK restore snapshot for one project. [DIAG-RESTORE]</summary>
    public static string ProjectAssetsFile(string project)
    {
        return Resolve(DirectoryOf(project), "obj", "project.assets.json");
    }

    private static readonly string[] RestoreAncestorNames =
    [
        "Directory.Build.props",
        "Directory.Build.targets",
        "Directory.Packages.props",
        "NuGet.Config",
        "nuget.config",
        "global.json",
    ];

    /// <summary>Known inherited SDK inputs, including newly created ancestor configuration. [DIAG-RESTORE]</summary>
    public static IEnumerable<string> RestoreAncestorFiles(string project)
    {
        foreach (var directory in RestoreAncestors(DirectoryOf(project)))
        {
            foreach (var name in RestoreAncestorNames)
            {
                var file = Resolve(directory, name);
                if (File.Exists(file))
                {
                    yield return file;
                }
            }
        }
    }

    private static IEnumerable<string> RestoreAncestors(string directory)
    {
        for (var current = directory; current.Length > 0; current = DirectoryOf(current))
        {
            yield return current;
        }
    }

    /// <summary>Literal imports only; MSBuild expressions and globs require SDK evaluation. [DIAG-RESTORE]</summary>
    public static string? LiteralRestoreImport(string definingFile, string? value)
    {
        return
            string.IsNullOrWhiteSpace(value)
            || value.IndexOfAny(['$', '@', '%', '*', '?', ';']) >= 0
            ? null
            : Resolve(DirectoryOf(definingFile), value);
    }
}
