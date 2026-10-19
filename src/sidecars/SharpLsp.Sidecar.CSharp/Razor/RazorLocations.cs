using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Moves C# answers out of Razor projections. Roslyn already maps a location inside a C#
/// fragment to its Razor file; a location still in a projection is hidden scaffolding and is
/// dropped, except a component's own class declaration, which lands at the start of its Razor
/// file because a component is its file. Implements [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
internal static class RazorLocations
{
    /// <summary><paramref name="result"/> with every projection location mapped or dropped.</summary>
    public static async Task<LocationListResult> MapAsync(
        Solution solution,
        LocationListResult result,
        CancellationToken ct
    )
    {
        // One lookup per file this request touches, not per location.
        var projections = new Dictionary<string, RazorProjection?>(NativePaths.Comparer);
        var mapped = new List<LocationResult>();
        foreach (var location in result.Locations)
        {
            if (!projections.TryGetValue(location.FilePath, out var projection))
            {
                projection = await FindProjectionAsync(solution, location.FilePath, ct)
                    .ConfigureAwait(false);
                projections[location.FilePath] = projection;
            }

            if (Map(projection, location) is { } kept)
            {
                mapped.Add(kept);
            }
        }

        return new LocationListResult { Locations = [.. mapped.DistinctBy(Key)] };
    }

    /// <summary><paramref name="location"/> mapped out of a projection, or null when it is hidden scaffolding.</summary>
    public static async Task<LocationResult?> MapAsync(
        Solution solution,
        LocationResult? location,
        CancellationToken ct
    )
    {
        if (location is null)
        {
            return null;
        }

        var projection = await FindProjectionAsync(solution, location.FilePath, ct)
            .ConfigureAwait(false);
        return Map(projection, location);
    }

    private static LocationResult? Map(RazorProjection? projection, LocationResult location)
    {
        return projection is null ? location : ComponentFileStart(projection, location);
    }

    /// <summary>
    /// The projection whose generated document lives at <paramref name="path"/>; null for a
    /// regular document, decompiled source, or a generated document that is not a projection.
    /// </summary>
    public static async Task<RazorProjection?> FindProjectionAsync(
        Solution solution,
        string path,
        CancellationToken ct
    )
    {
        if (SolutionPaths.FindDocument(solution, path) is not null)
        {
            return null;
        }

        foreach (var project in solution.Projects)
        {
            var generated = await project
                .GetSourceGeneratedDocumentsAsync(ct)
                .ConfigureAwait(false);
            if (
                generated.FirstOrDefault(document =>
                    NativePaths.AreEqual(document.FilePath, path)
                ) is
                { } found
            )
            {
                return await RazorProjection.ForGeneratedAsync(found, ct).ConfigureAwait(false);
            }
        }

        return null;
    }

    private static LocationResult? ComponentFileStart(
        RazorProjection projection,
        LocationResult location
    )
    {
        var position = new LinePosition(location.Line, location.Character);
        return
            DocumentText.TryOffset(projection.GeneratedText, position) is { } offset
            && DeclaresComponentClass(projection.GeneratedRoot.FindToken(offset))
            ? new LocationResult { FilePath = projection.RazorPath }
            : null;
    }

    private static bool DeclaresComponentClass(SyntaxToken token)
    {
        return token.Parent is ClassDeclarationSyntax declaration
            && declaration.Identifier == token;
    }

    private static (string, int, int, int, int) Key(LocationResult location)
    {
        return (
            NativePaths.IdentityOf(location.FilePath),
            location.Line,
            location.Character,
            location.EndLine,
            location.EndCharacter
        );
    }
}
