using System.Text.Json;
using Serilog;

namespace SharpLsp.Sidecar.Common.References;

/// <summary>
/// The package that put an assembly on a project's references, read from the project's
/// <c>obj/project.assets.json</c>: the package whose <c>compile</c> items include an assembly of
/// that file name. Implements [REFACTOR-IMPORT-REFERENCE] (a package another project uses).
/// </summary>
public static class PackageOfAssembly
{
    /// <summary>
    /// The package of <paramref name="project"/>'s restore that compiles against
    /// <paramref name="assemblyPath"/>; null when no package does or the assets are unreadable.
    /// </summary>
    public static PackageIdentity? Find(string project, string assemblyPath)
    {
        try
        {
            using var document = PackageAssets.ReadDocument(project);
            return
                Packages(document.RootElement)
                    .FirstOrDefault(package => Compiles(package.Value, assemblyPath))
                    is { Name: { } name }
                ? Identity(name)
                : null;
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
            Log.Warning(error, "No package assets for {Project}", project);
            return null;
        }
    }

    /// <summary>Every package entry of every target framework.</summary>
    private static IEnumerable<JsonProperty> Packages(JsonElement assets)
    {
        return assets
            .GetProperty("targets")
            .EnumerateObject()
            .SelectMany(target => target.Value.EnumerateObject())
            .Where(entry =>
                entry.Value.TryGetProperty("type", out var kind) && kind.GetString() == "package"
            );
    }

    /// <summary>Whether the package entry compiles against an assembly named like <paramref name="assemblyPath"/>.</summary>
    private static bool Compiles(JsonElement package, string assemblyPath)
    {
        return package.TryGetProperty("compile", out var compile)
            && compile.EnumerateObject().Any(item => NativePaths.SameName(item.Name, assemblyPath));
    }

    /// <summary>The <c>Id/Version</c> key of an assets target entry.</summary>
    private static PackageIdentity? Identity(string key)
    {
        var slash = key.IndexOf('/', StringComparison.Ordinal);
        return slash <= 0 ? null : new PackageIdentity(key[..slash], key[(slash + 1)..]);
    }
}
