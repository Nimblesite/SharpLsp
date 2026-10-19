using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The Razor half of a rename. Roslyn's renamer edits regular documents only, never the
/// projections, so each declaration and use that Roslyn maps into a Razor file is edited
/// there, at its mapped span, when that span holds the old name. Hidden scaffolding maps to
/// no Razor span and is never edited. Implements [RAZOR-FEATURES-RENAME].
/// </summary>
internal static class RazorRenameEdits
{
    /// <summary>The Razor edits that rename <paramref name="symbol"/> to <paramref name="newName"/>.</summary>
    public static async Task<List<DocumentEditResult>> FindAsync(
        Solution solution,
        ISymbol symbol,
        string newName,
        CancellationToken ct
    )
    {
        var referenced = await SymbolFinder
            .FindReferencesAsync(symbol, solution, ct)
            .ConfigureAwait(false);
        return await FromReferencesAsync(solution, referenced, (symbol.Name, newName), ct)
            .ConfigureAwait(false);
    }

    /// <summary>The Razor edits among <paramref name="referenced"/> that rewrite <c>names.Old</c>.</summary>
    public static async Task<List<DocumentEditResult>> FromReferencesAsync(
        Solution solution,
        IEnumerable<ReferencedSymbol> referenced,
        (string Old, string New) names,
        CancellationToken ct
    )
    {
        var spans = referenced
            .SelectMany(reference =>
                reference.Definition.Locations.Concat(
                    reference.Locations.Select(use => use.Location)
                )
            )
            .Where(location => location.IsInSource)
            .Select(location => location.GetMappedLineSpan())
            .Where(span => span.HasMappedPath && NativePaths.IsRazor(span.Path));
        var edits = new List<DocumentEditResult>();
        foreach (var file in spans.GroupBy(span => span.Path, NativePaths.Comparer))
        {
            if (await EditFileAsync(solution, file, names, ct).ConfigureAwait(false) is { } edit)
            {
                edits.Add(edit);
            }
        }

        return edits;
    }

    private static async Task<DocumentEditResult?> EditFileAsync(
        Solution solution,
        IGrouping<string, FileLinePositionSpan> file,
        (string Old, string New) names,
        CancellationToken ct
    )
    {
        var razor = SolutionPaths.AdditionalDocumentsAt(solution, file.Key).FirstOrDefault();
        if (razor is null)
        {
            return null;
        }

        var text = await razor.GetTextAsync(ct).ConfigureAwait(false);
        var edits = file.Select(span => span.Span)
            .Distinct()
            .Where(span => Holds(text, span, names.Old))
            .OrderBy(span => span.Start)
            .Select(span => RazorResults.Edit(span, names.New))
            .ToList();
        return edits.Count == 0
            ? null
            : new DocumentEditResult { FilePath = file.Key, Edits = edits };
    }

    /// <summary>Whether <paramref name="span"/> of <paramref name="text"/> is exactly <paramref name="name"/>.</summary>
    private static bool Holds(SourceText text, LinePositionSpan span, string name)
    {
        return DocumentText.TrySpan(text, span) is { } found
            && found.Length == name.Length
            && string.Equals(text.ToString(found), name, StringComparison.Ordinal);
    }
}
