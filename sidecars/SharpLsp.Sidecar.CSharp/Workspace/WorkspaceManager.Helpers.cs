using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

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

            result.AdditionalEdits.Add(DocumentText.ToTextEdit(text, textChange));
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
            if (string.IsNullOrEmpty(filePath) || IsGeneratedBuildOutput(filePath))
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
    /// MSBuild-generated files under <c>obj/</c> (AssemblyInfo, GlobalUsings,
    /// AssemblyAttributes) belong to the build system, not the user. Diagnostics
    /// against them are never actionable and produce noisy false positives when
    /// transient assembly references aren't fully resolved during a scan.
    /// </summary>
    private static bool IsGeneratedBuildOutput(string filePath)
    {
        return filePath.Contains(
                $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}",
                StringComparison.Ordinal
            ) || filePath.Contains("/obj/", StringComparison.Ordinal);
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

    /// <summary>
    /// Shared skeleton for document-scoped semantic queries: look up the document,
    /// return <paramref name="emptyValue"/> when it is missing, otherwise run
    /// <paramref name="resolve"/> and wrap its payload in a success result. Any
    /// exception is mapped to a failure carrying its message.
    /// </summary>
    private async Task<Outcome.Result<TValue, string>> RunDocumentQueryAsync<TValue>(
        string filePath,
        TValue emptyValue,
        Func<Document, Task<TValue>> resolve,
        CancellationToken ct
    )
        where TValue : notnull
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            var value =
                document is null
                    ? emptyValue
                    : await resolve(document).ConfigureAwait(false);
            return new Outcome.Result<TValue, string>.Ok<TValue, string>(value);
        }
        catch (Exception ex)
        {
            return Outcome.Result<TValue, string>.Failure(ex.Message);
        }
    }
}
