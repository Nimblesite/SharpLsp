using System.Text.Json;
using Serilog;
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
            var assets = NativePaths.ProjectAssetsFile(project);
            if (!File.Exists(assets))
            {
                return new MissingPackagesResult.Ok<string[], string>([]);
            }
            using var document = ReadDocument(project);
            return new MissingPackagesResult.Ok<string[], string>(AbsentFrom(document.RootElement));
        }
        catch (Exception)
        {
            return MissingPackagesResult.Failure("Could not read project package assets.");
        }
    }

    /// <summary>
    /// <paramref name="project"/> spelled as the restore that wrote its assets spelled it. A
    /// link, or a Windows drive letter in the other case, is the same project to the user, but
    /// a design-time build under a second spelling rewrites <c>obj</c> inputs whose paths
    /// follow the spelling, and the user's next build recompiles. The given spelling when the
    /// assets are unreadable or name another file. [DEBUG-FEATURES-LAUNCH-BUILD]
    /// </summary>
    public static string RestoredSpelling(string project)
    {
        try
        {
            using var document = ReadDocument(project);
            var restored = document
                .RootElement.GetProperty("project")
                .GetProperty("restore")
                .GetProperty("projectPath")
                .GetString();
            return restored is not null && NativePaths.AreEqual(restored, project)
                ? restored
                : project;
        }
        catch (Exception error)
            when (error
                    is IOException
                        or UnauthorizedAccessException
                        or JsonException
                        or KeyNotFoundException
                        or InvalidOperationException
            )
        {
            Log.Debug(error, "No restored spelling for {Project}", project);
            return project;
        }
    }

    internal static JsonDocument ReadDocument(string project)
    {
        return JsonDocument.Parse(File.ReadAllText(NativePaths.ProjectAssetsFile(project)));
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
        // Missing SDK tables are invalid assets, even when the JSON itself is readable.
        return
        [
            .. document
                .GetProperty("packageFolders")
                .EnumerateObject()
                .Select(folder => folder.Name),
        ];
    }

    private static IEnumerable<string> PackageFolders(JsonElement document)
    {
        return document
            .GetProperty("libraries")
            .EnumerateObject()
            .Select(library => PackageFolder(library.Value))
            .OfType<string>();
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
