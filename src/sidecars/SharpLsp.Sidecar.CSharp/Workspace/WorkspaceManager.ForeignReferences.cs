using ReferencesResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>A symbol the other sidecar names by identity, and whether its declaration counts.</summary>
internal readonly record struct ForeignSymbolQuery(
    string AssemblyName,
    string XmlDocSig,
    bool IncludeDeclaration
);

internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Every C# and Razor use of the symbol the other sidecar names by identity, and its C#
    /// declaration when C# declares it. Razor uses land in their Razor files, and hidden
    /// scaffolding is dropped. Implements [REFERENCES-CROSS-LANGUAGE] and [RAZOR-FSHARP-REFERENCES].
    /// </summary>
    public async Task<ReferencesResult> GetForeignReferencesAsync(
        ForeignSymbolQuery query,
        CancellationToken ct = default
    )
    {
        try
        {
            return new ReferencesResult.Ok<LocationListResult, string>(
                await ForeignReferencesAsync(query, ct).ConfigureAwait(false)
            );
        }
        catch (Exception ex)
        {
            return ReferencesResult.Failure(ex.Message);
        }
    }

    private async Task<LocationListResult> ForeignReferencesAsync(
        ForeignSymbolQuery query,
        CancellationToken ct
    )
    {
        var solution = _solution;
        if (
            solution is null
            || string.IsNullOrWhiteSpace(query.AssemblyName)
            || string.IsNullOrWhiteSpace(query.XmlDocSig)
        )
        {
            return new LocationListResult();
        }

        var scope = new SearchScope(solution, null, null);
        var identity = new ForeignRenameKey(query.AssemblyName, query.XmlDocSig);
        var symbols = await ResolveForeignSymbolsAsync(solution, identity, ct)
            .ConfigureAwait(false);
        var found = await Task.WhenAll(
                symbols.Select(symbol =>
                    ReferenceResolver.ReferencesOfAsync(symbol, scope, query.IncludeDeclaration, ct)
                )
            )
            .ConfigureAwait(false);
        return await MapLocationsAsync(
                ReferenceResolver.Distinct(found.SelectMany(result => result.Locations)),
                ct
            )
            .ConfigureAwait(false);
    }
}
