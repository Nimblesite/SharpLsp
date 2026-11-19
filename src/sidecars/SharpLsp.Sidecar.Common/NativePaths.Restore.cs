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

    /// <summary>The reserved property naming the directory of the file an import is written in.</summary>
    private const string ThisFileDirectory = "$(MSBuildThisFileDirectory)";

    /// <summary>
    /// Literal imports only; MSBuild expressions and globs require SDK evaluation. A path that
    /// starts with the reserved <c>$(MSBuildThisFileDirectory)</c> is literal: MSBuild defines
    /// it as the directory of the importing file and nothing can redefine it. [DIAG-RESTORE]
    /// </summary>
    public static string? LiteralRestoreImport(string definingFile, string? value)
    {
        var relative =
            value?.StartsWith(ThisFileDirectory, StringComparison.OrdinalIgnoreCase) == true
                ? value[ThisFileDirectory.Length..]
                : value;
        return
            string.IsNullOrWhiteSpace(relative)
            || relative.IndexOfAny(['$', '@', '%', '*', '?', ';']) >= 0
            ? null
            : Resolve(DirectoryOf(definingFile), relative);
    }

    /// <summary>Whether <paramref name="file"/> is MSBuild XML that can import other files.</summary>
    public static bool IsMSBuildFile(string file)
    {
        return HasExtension(file, ".props")
            || HasExtension(file, ".targets")
            || HasExtension(file, ".csproj")
            || HasExtension(file, ".fsproj")
            || HasExtension(file, ".vbproj");
    }
}
