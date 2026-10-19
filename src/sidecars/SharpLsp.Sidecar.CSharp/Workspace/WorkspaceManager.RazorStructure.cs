using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Syntax requests for Razor files, which the host forwards because it has no Razor
/// grammar. Implements [RAZOR-ARCHITECTURE-ROUTING] and [RAZOR-FEATURES-STRUCTURE].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>The folding ranges of a Razor file; empty for a file no project lists.</summary>
    public Task<Outcome.Result<List<FoldingRangeResult>, string>> GetFoldingRangesAsync(
        string filePath,
        CancellationToken ct
    )
    {
        return RunMarkupQueryAsync(
            filePath,
            [],
            markup => Task.FromResult(RazorStructure.Folds(markup)),
            ct
        );
    }

    /// <summary>The outline of a Razor file; empty for a file no project lists.</summary>
    public Task<Outcome.Result<List<DocumentSymbolResult>, string>> GetDocumentSymbolsAsync(
        string filePath,
        CancellationToken ct
    )
    {
        return RunMarkupQueryAsync(
            filePath,
            [],
            async markup =>
            {
                var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
                var members = projection is null ? [] : RazorStructure.Members(projection);
                return RazorStructure.Symbols(markup, members);
            },
            ct
        );
    }

    /// <summary>The tag names edited together with the one at the position, or none.</summary>
    public Task<Outcome.Result<LocationListResult, string>> GetLinkedEditingRangesAsync(
        string filePath,
        (int Line, int Character) at,
        CancellationToken ct
    )
    {
        return RunMarkupQueryAsync(
            filePath,
            new LocationListResult(),
            markup => Task.FromResult(LinkedNames(filePath, markup, at)),
            ct
        );
    }

    private static LocationListResult LinkedNames(
        string filePath,
        RazorMarkup markup,
        (int Line, int Character) at
    )
    {
        var offset = DocumentText.TryOffset(markup.Text, new LinePosition(at.Line, at.Character));
        var spans = offset is { } found ? RazorStructure.LinkedNames(markup, found) : [];
        return new LocationListResult
        {
            Locations =
            [
                .. spans.Select(span =>
                    DocumentPosition.ToLocationResult(
                        new FileLinePositionSpan(
                            filePath,
                            markup.Text.Lines.GetLinePositionSpan(span)
                        )
                    )
                ),
            ],
        };
    }

    /// <summary>Run <paramref name="query"/> on a Razor file's markup facts; <paramref name="empty"/> when it has none.</summary>
    private async Task<Outcome.Result<T, string>> RunMarkupQueryAsync<T>(
        string filePath,
        T empty,
        Func<RazorMarkup, Task<T>> query,
        CancellationToken ct
    )
    {
        try
        {
            var markup = await FindRazorMarkupAsync(filePath, ct).ConfigureAwait(false);
            var value = markup is null ? empty : await query(markup).ConfigureAwait(false);
            return new Outcome.Result<T, string>.Ok<T, string>(value);
        }
        catch (Exception ex)
        {
            return Outcome.Result<T, string>.Failure(ex.Message);
        }
    }
}
