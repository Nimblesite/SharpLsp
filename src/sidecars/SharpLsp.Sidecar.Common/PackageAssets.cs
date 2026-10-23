using System.Text.Json;
using MissingPackagesResult = Outcome.Result<string[], string>;

namespace SharpLsp.Sidecar.Common;

/// <summary>The packages restored in SDK assets that no package folder holds. [DIAG-RESTORE]</summary>
public static class PackageAssets
{
    /// <summary>Missing assets have no prior package set; unreadable assets return a failure.</summary>
    public static MissingPackagesResult MissingPackages(string project)
    {
        try
        {
            var assets = NativePaths.Resolve(
                NativePaths.DirectoryOf(project),
                "obj",
                "project.assets.json"
            );
            if (!File.Exists(assets))
            {
                return new MissingPackagesResult.Ok<string[], string>([]);
            }
            using var document = JsonDocument.Parse(File.ReadAllText(assets));
            return new MissingPackagesResult.Ok<string[], string>(AbsentFrom(document.RootElement));
        }
        catch (Exception)
        {
            return MissingPackagesResult.Failure("Could not read project package assets.");
        }
    }

    private static string[] AbsentFrom(JsonElement document)
    {
        var roots = PackageRoots(document);
        return
        [
            .. PackageFolders(document)
                .Where(folder =>
                    !roots.Any(root => Directory.Exists(NativePaths.Resolve(root, folder)))
                ),
        ];
    }

    private static string[] PackageRoots(JsonElement document)
    {
        return document.TryGetProperty("packageFolders", out var folders)
            ? [.. folders.EnumerateObject().Select(folder => folder.Name)]
            : [];
    }

    private static IEnumerable<string> PackageFolders(JsonElement document)
    {
        return document.TryGetProperty("libraries", out var libraries)
            ? libraries
                .EnumerateObject()
                .Select(library => PackageFolder(library.Value))
                .OfType<string>()
            : [];
    }

    private static string? PackageFolder(JsonElement library)
    {
        return
            library.TryGetProperty("type", out var kind)
            && kind.GetString() == "package"
            && library.TryGetProperty("path", out var path)
            ? path.GetString()
            : null;
    }
}
