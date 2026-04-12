using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Text;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Private helpers: diagnostics mapping, completion mapping, document lookup.
/// </summary>
internal sealed partial class WorkspaceManager
{
    private CompletionList? _lastCompletionList;
    private Document? _lastCompletionDocument;

    private static List<DiagnosticResult> MapDiagnostics(
        string filePath,
        SemanticModel model,
        CancellationToken ct
    )
    {
        var results = new List<DiagnosticResult>();
        foreach (var diag in model.GetDiagnostics(cancellationToken: ct))
        {
            var span = diag.Location.GetMappedLineSpan();
            if (!span.IsValid)
            {
                continue;
            }

            results.Add(MapOneDiagnostic(filePath, diag, span));
        }

        return results;
    }

    private static DiagnosticResult MapOneDiagnostic(
        string filePath,
        Diagnostic diag,
        FileLinePositionSpan span
    )
    {
        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = span.StartLinePosition.Line,
            StartCharacter = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
            Message = diag.GetMessage(System.Globalization.CultureInfo.InvariantCulture),
            Severity = diag.Severity.ToString(),
            Code = diag.Id,
        };
    }

    private async Task<List<CompletionItem>> GetCompletionsCoreAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
        if (document is null)
        {
            return [];
        }

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(line, character));

        var service = CompletionService.GetService(document);
        if (service is null)
        {
            return [];
        }

        var completions = await service
            .GetCompletionsAsync(document, position, cancellationToken: ct)
            .ConfigureAwait(false);
        if (completions is null)
        {
            return [];
        }

        _lastCompletionList = completions;
        _lastCompletionDocument = document;
        return MapCompletionItems(completions);
    }

    private static List<CompletionItem> MapCompletionItems(CompletionList completions)
    {
        var results = new List<CompletionItem>();
        for (var i = 0; i < completions.ItemsList.Count; i++)
        {
            var item = completions.ItemsList[i];
            // Items from unimported namespaces have InlineDescription set to the namespace.
            var hasImportHint =
                item.InlineDescription.Length > 0 && !string.IsNullOrEmpty(item.InlineDescription);
            var detail = hasImportHint
                ? $"(import) {item.InlineDescription}"
                : item.InlineDescription;
            results.Add(
                new CompletionItem
                {
                    Label = item.DisplayText,
                    Kind = item.Tags.Length > 0 ? item.Tags[0] : "Text",
                    Detail = detail,
                    InsertText = item.FilterText,
                    Index = i,
                }
            );
        }

        return results;
    }

    internal async Task<CompletionResolveResult> ResolveCompletionAsync(
        int index,
        CancellationToken ct
    )
    {
        var result = new CompletionResolveResult();
        if (
            _lastCompletionList is null
            || _lastCompletionDocument is null
            || index < 0
            || index >= _lastCompletionList.ItemsList.Count
        )
        {
            return result;
        }

        var roslynItem = _lastCompletionList.ItemsList[index];
        var service = CompletionService.GetService(_lastCompletionDocument);
        if (service is null)
        {
            return result;
        }

        var change = await service
            .GetChangeAsync(_lastCompletionDocument, roslynItem, cancellationToken: ct)
            .ConfigureAwait(false);
        var text = await _lastCompletionDocument.GetTextAsync(ct).ConfigureAwait(false);
        var completionSpan = roslynItem.Span;

        foreach (var textChange in change.TextChanges)
        {
            if (textChange.Span.OverlapsWith(completionSpan))
            {
                continue;
            }

            var startPos = text.Lines.GetLinePosition(textChange.Span.Start);
            var endPos = text.Lines.GetLinePosition(textChange.Span.End);
            result.AdditionalEdits.Add(
                new TextEditResult
                {
                    StartLine = startPos.Line,
                    StartCharacter = startPos.Character,
                    EndLine = endPos.Line,
                    EndCharacter = endPos.Character,
                    NewText = textChange.NewText ?? "",
                }
            );
        }

        return result;
    }

    private IEnumerable<Project> FilterProjects(string[] filter)
    {
        return filter.Length == 0
            ? _solution!.Projects
            : _solution!.Projects.Where(project =>
                filter.Any(pattern =>
                    project.Name.Contains(pattern, StringComparison.OrdinalIgnoreCase)
                )
            );
    }

    private static async Task CollectProjectDiagnosticsAsync(
        Project project,
        Dictionary<string, List<DiagnosticResult>> results,
        CancellationToken ct
    )
    {
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation is null)
        {
            return;
        }

        foreach (var tree in compilation.SyntaxTrees)
        {
            ct.ThrowIfCancellationRequested();
            var filePath = tree.FilePath;
            if (string.IsNullOrEmpty(filePath))
            {
                continue;
            }

            var model = compilation.GetSemanticModel(tree);
            var diagnostics = MapDiagnostics(filePath, model, ct);
            if (diagnostics.Count > 0)
            {
                results[filePath] = diagnostics;
            }
        }
    }

    /// <summary>
    /// Find a document by file path, searching regular documents first,
    /// then falling back to source-generated documents.
    /// </summary>
    internal async Task<Document?> FindDocumentAsync(string filePath, CancellationToken ct)
    {
        if (_solution is null)
        {
            return null;
        }

        try
        {
            var normalizedPath = Path.GetFullPath(filePath);
            return FindRegularDocumentByPath(normalizedPath)
                ?? await FindSourceGeneratedDocumentByPathAsync(normalizedPath, ct)
                    .ConfigureAwait(false);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private Document? FindRegularDocumentByPath(string normalizedPath)
    {
        foreach (var project in _solution!.Projects)
        {
            foreach (var document in project.Documents)
            {
                if (IsPathMatch(document.FilePath, normalizedPath))
                {
                    return document;
                }
            }
        }

        return null;
    }

    private async Task<Document?> FindSourceGeneratedDocumentByPathAsync(
        string normalizedPath,
        CancellationToken ct
    )
    {
        foreach (var project in _solution!.Projects)
        {
            var generatedDocs = await project
                .GetSourceGeneratedDocumentsAsync(ct)
                .ConfigureAwait(false);

            foreach (var document in generatedDocs)
            {
                if (IsPathMatch(document.FilePath, normalizedPath))
                {
                    return document;
                }
            }
        }

        return null;
    }

    private static bool IsPathMatch(string? documentPath, string normalizedPath)
    {
        return documentPath is not null
            && string.Equals(
                Path.GetFullPath(documentPath),
                normalizedPath,
                StringComparison.OrdinalIgnoreCase
            );
    }
}
