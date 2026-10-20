using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// References and highlights of what markup names: a component's tags across the solution's
/// Razor files, and the C# uses of a symbol named from markup. Implements
/// [RAZOR-FEATURES-REFERENCES].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>Whether any project lists a Razor file: only then can markup name a symbol.</summary>
    private bool HasRazorFiles()
    {
        return _solution?.Projects.Any(project =>
                project.AdditionalDocuments.Any(document => NativePaths.IsRazor(document.FilePath))
            ) == true;
    }

    /// <summary>References, then a markup-named symbol's C# references, then a component's tags.</summary>
    private async Task<LocationListResult> WithMarkupReferencesAsync(
        LocationListResult found,
        string filePath,
        (int Line, int Character) at,
        bool includeDeclaration,
        CancellationToken ct
    )
    {
        var symbol = await SymbolAtAsync(filePath, at.Line, at.Character, ct).ConfigureAwait(false);
        var markup =
            found.Locations.Count == 0 && symbol is not null && NativePaths.IsRazor(filePath)
                ? await MarkupReferencesAsync(filePath, symbol, includeDeclaration, ct)
                    .ConfigureAwait(false)
                : [];
        var tags = await ComponentTagsAsync(symbol, null, ct).ConfigureAwait(false);
        return ReferenceResolver.Distinct([.. found.Locations, .. markup, .. tags]);
    }

    /// <summary>Highlights, then a markup-named symbol's C# uses, then a component's tags in the file.</summary>
    private async Task<DocumentHighlightListResult> WithMarkupHighlightsAsync(
        DocumentHighlightListResult found,
        string filePath,
        (int Line, int Character) at,
        CancellationToken ct
    )
    {
        var symbol = await SymbolAtAsync(filePath, at.Line, at.Character, ct).ConfigureAwait(false);
        var markup =
            found.Highlights.Count == 0 && symbol is not null
                ? await MarkupHighlightsAsync(filePath, symbol, ct).ConfigureAwait(false)
                : [];
        var tags = await ComponentTagsAsync(symbol, filePath, ct).ConfigureAwait(false);
        return new DocumentHighlightListResult
        {
            Highlights =
            [
                .. found
                    .Highlights.Concat(markup)
                    .Concat(tags.Select(TagHighlight))
                    .DistinctBy(h => (h.StartLine, h.StartCharacter, h.EndLine, h.EndCharacter)),
            ],
        };
    }

    private static DocumentHighlightResult TagHighlight(LocationResult tag)
    {
        return new DocumentHighlightResult
        {
            StartLine = tag.Line,
            StartCharacter = tag.Character,
            EndLine = tag.EndLine,
            EndCharacter = tag.EndCharacter,
            Kind = ReferenceResolver.ReadKind,
        };
    }

    /// <summary>The symbol a position names: the C# there, else the markup name in a Razor file.</summary>
    private async Task<ISymbol?> SymbolAtAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var csharp = await RunPositionQueryAsync<ISymbol?>(
                filePath,
                (line, character),
                null,
                target =>
                    DefinitionResolver.ResolveSymbolAsync(
                        target.Document,
                        target.Line,
                        target.Character,
                        ct
                    ),
                ct
            )
            .ConfigureAwait(false);
        return csharp is Outcome.Result<ISymbol?, string>.Ok<ISymbol?, string> { Value: { } found }
            ? found
            : await MarkupSymbolAsync(filePath, line, character, ct).ConfigureAwait(false);
    }

    private async Task<ISymbol?> MarkupSymbolAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var razor = NativePaths.IsRazor(filePath) ? FindRazorDocument(filePath) : null;
        var at = razor is null
            ? null
            : await MarkupAtAsync(razor, line, character, ct).ConfigureAwait(false);
        return at is { } found
            ? RazorMarkupSymbols.At(found.Compilation, found.Markup, found.Offset)?.Symbol
            : null;
    }

    /// <summary>
    /// The C# references of a symbol named from markup in a Razor file, mapped out of the
    /// projections, searched from that file's project.
    /// </summary>
    private async Task<List<LocationResult>> MarkupReferencesAsync(
        string filePath,
        ISymbol symbol,
        bool includeDeclaration,
        CancellationToken ct
    )
    {
        var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
        if (projection is null)
        {
            return [];
        }

        var scope = await SearchScope
            .OfAsync(projection.Generated, _activeFrameworks, ct)
            .ConfigureAwait(false);
        var found = await ReferenceResolver
            .ReferencesOfAsync(symbol, scope, includeDeclaration, ct)
            .ConfigureAwait(false);
        return (await MapLocationsAsync(found, ct).ConfigureAwait(false)).Locations;
    }

    /// <summary>The C# highlights, in a Razor file, of a symbol named from its markup.</summary>
    private async Task<List<DocumentHighlightResult>> MarkupHighlightsAsync(
        string filePath,
        ISymbol symbol,
        CancellationToken ct
    )
    {
        var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
        return projection is null
            ? []
            : await ReferenceResolver
                .HighlightsOfAsync(symbol, projection.Generated, filePath, ct)
                .ConfigureAwait(false);
    }

    /// <summary>
    /// The start and end tag names that instantiate <paramref name="symbol"/>, a component
    /// type, in every Razor file of the solution, or only in <paramref name="onlyFile"/>.
    /// </summary>
    private async Task<List<LocationResult>> ComponentTagsAsync(
        ISymbol? symbol,
        string? onlyFile,
        CancellationToken ct
    )
    {
        var tags = new List<LocationResult>();
        if (RazorComponentTags.IdOf(symbol) is not { } id || _solution is null)
        {
            return tags;
        }

        foreach (var project in FilterProjects([]))
        {
            tags.AddRange(await ProjectTagsAsync(project, id, onlyFile, ct).ConfigureAwait(false));
        }

        return tags;
    }

    private static async Task<List<LocationResult>> ProjectTagsAsync(
        Project project,
        string typeId,
        string? onlyFile,
        CancellationToken ct
    )
    {
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        var found = new List<LocationResult>();
        foreach (var razor in project.AdditionalDocuments.Where(d => Searched(d, onlyFile)))
        {
            var markup = await RazorMarkupEngine.ProcessAsync(razor, ct).ConfigureAwait(false);
            if (markup is not null && compilation is not null)
            {
                found.AddRange(
                    RazorComponentTags
                        .Instantiating(markup, compilation, typeId)
                        .Select(span => TagLocation(razor.FilePath!, markup.Text, span))
                );
            }
        }

        return found;
    }

    private static bool Searched(TextDocument document, string? onlyFile)
    {
        return NativePaths.IsRazor(document.FilePath)
            && (onlyFile is null || NativePaths.AreEqual(onlyFile, document.FilePath));
    }

    private static LocationResult TagLocation(string path, SourceText text, TextSpan span)
    {
        return DocumentPosition.ToLocationResult(
            new FileLinePositionSpan(path, text.Lines.GetLinePositionSpan(span))
        );
    }
}
