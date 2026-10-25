using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Private helpers: diagnostics mapping, completion mapping, document lookup.
/// </summary>
internal sealed partial class WorkspaceManager
{
    private CompletionList? _lastCompletionList;
    private Document? _lastCompletionDocument;
    private RazorProjection? _lastCompletionOrigin;

    private static List<DiagnosticResult> MapDiagnostics(
        string filePath,
        SemanticModel model,
        CancellationToken ct
    )
    {
        return MapAnalyzerDiagnostics(filePath, model.GetDiagnostics(cancellationToken: ct));
    }

    /// <summary>Compiler and analyzer locations share one canonical mapping pipeline.</summary>
    private static List<DiagnosticResult> MapAnalyzerDiagnostics(
        string filePath,
        IEnumerable<Diagnostic> diagnostics
    )
    {
        var results = new List<DiagnosticResult>();
        foreach (var diag in diagnostics)
        {
            // A diagnostic belongs to the file its location maps to: a projection's hidden
            // scaffolding maps nowhere and drops out. [RAZOR-FEATURES-DIAGNOSTICS]
            var span = diag.Location.GetMappedLineSpan();
            if (
                !span.IsValid
                || !NativePaths.AreEqual(span.Path, filePath)
                || MayServeMarkup(diag, filePath)
            )
            {
                continue;
            }

            results.Add(MapOneDiagnostic(filePath, diag, span));
        }

        return results;
    }

    /// <summary>
    /// Whether <paramref name="diag"/> calls a using unnecessary in a Razor file, where Roslyn
    /// sees only the projection: markup resolves component tags through usings that the
    /// generated C# never needs, since it names each component in full, and an import file's
    /// usings serve the files beside and below it. [RAZOR-FEATURES-DIAGNOSTICS]
    /// </summary>
    private static bool MayServeMarkup(Diagnostic diag, string filePath)
    {
        return diag.Id is "CS8019" or "IDE0005" && NativePaths.IsRazor(filePath);
    }

    private static DiagnosticResult MapOneDiagnostic(
        string filePath,
        Diagnostic diag,
        FileLinePositionSpan span
    )
    {
        return DocumentPosition.ToDiagnostic(
            new FileLinePositionSpan(filePath, span.Span),
            diag.Id,
            diag.Severity.ToString(),
            diag.GetMessage(System.Globalization.CultureInfo.InvariantCulture)
        );
    }

    private async Task<List<CompletionItem>> GetCompletionsCoreAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        if (
            await ResolveCompletionTargetAsync(filePath, (line, character), ct)
                .ConfigureAwait(false)
            is not { } target
        )
        {
            return [];
        }

        var document = target.Document;
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(target.Line, target.Character));

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
        _lastCompletionOrigin = target.Origin;
        var editSpan = ComputeCompletionEditSpan(service, text, position);
        return RazorResults.MapCompletions(
            MapCompletionItems(completions, editSpan),
            target.Origin
        );
    }

    // Roslyn's default completion span covers the typed prefix to the LEFT of the
    // caret; extend it over any identifier characters that already follow the caret
    // so an accepted item REPLACES an existing member name instead of being appended
    // to it (`Console.WriteLineWriteLine`). GitHub #178.
    // Implements [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT].
    private static LinePositionSpan ComputeCompletionEditSpan(
        CompletionService service,
        SourceText text,
        int position
    )
    {
        var span = service.GetDefaultCompletionListSpan(text, position);
        var end = span.End;
        while (
            end < text.Length
            && Microsoft.CodeAnalysis.CSharp.SyntaxFacts.IsIdentifierPartCharacter(text[end])
        )
        {
            end++;
        }

        return text.Lines.GetLinePositionSpan(TextSpan.FromBounds(span.Start, end));
    }

    private static List<CompletionItem> MapCompletionItems(
        CompletionList completions,
        LinePositionSpan editSpan
    )
    {
        var results = new List<CompletionItem>(completions.ItemsList.Count);
        for (var i = 0; i < completions.ItemsList.Count; i++)
        {
            results.Add(MapOneCompletionItem(completions.ItemsList[i], i, editSpan));
        }

        return results;
    }

    private static CompletionItem MapOneCompletionItem(
        Microsoft.CodeAnalysis.Completion.CompletionItem item,
        int index,
        LinePositionSpan editSpan
    )
    {
        // Items from unimported namespaces have InlineDescription set to the namespace.
        var hasImportHint =
            item.InlineDescription.Length > 0 && !string.IsNullOrEmpty(item.InlineDescription);
        var detail = hasImportHint ? $"(import) {item.InlineDescription}" : item.InlineDescription;
        return new CompletionItem
        {
            Label = item.DisplayText,
            Kind = item.Tags.Length > 0 ? item.Tags[0] : "Text",
            Detail = detail,
            InsertText = item.FilterText,
            Index = index,
            TextEdit = new TextEditResult
            {
                StartLine = editSpan.Start.Line,
                StartCharacter = editSpan.Start.Character,
                EndLine = editSpan.End.Line,
                EndCharacter = editSpan.End.Character,
                NewText = item.FilterText,
            },
        };
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

        var additional = change.TextChanges.Where(textChange =>
            !textChange.Span.IntersectsWith(completionSpan)
        );
        result.AdditionalEdits.AddRange(
            _lastCompletionOrigin is { } origin
                ? RazorCompletionEdits.Map(
                    origin,
                    additional,
                    await RazorMarkupEngine.ProcessAsync(origin.Razor, ct).ConfigureAwait(false)
                )
                : additional.Select(textChange => DocumentText.ToTextEdit(text, textChange))
        );
        return result;
    }

    private IEnumerable<Project> FilterProjects(string[] filter)
    {
        // Only each project's ACTIVE framework reports: every framework would
        // publish the same file's diagnostics again ([NETFX-CONTEXT]).
        var active = _solution!.Projects.Where(project =>
            TargetFrameworks.IsActive(_solution, project, _activeFrameworks)
        );
        return filter.Length == 0
            ? active
            : active.Where(project =>
                filter.Any(pattern =>
                    project.Name.Contains(pattern, StringComparison.OrdinalIgnoreCase)
                )
            );
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
            return TargetFrameworks.FindActiveDocument(_solution, filePath, _activeFrameworks)
                ?? await FindSourceGeneratedDocumentByPathAsync(filePath, ct).ConfigureAwait(false);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private async Task<Document?> FindSourceGeneratedDocumentByPathAsync(
        string filePath,
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
                if (NativePaths.AreEqual(document.FilePath, filePath))
                {
                    return document;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Shared skeleton for document-scoped semantic queries: look up the document,
    /// return <paramref name="emptyValue"/> when it is missing, otherwise run
    /// <paramref name="resolve"/> and wrap its payload in a success result. Any
    /// exception is mapped to a failure carrying its message.
    /// </summary>
    private Task<Outcome.Result<TValue, string>> RunDocumentQueryAsync<TValue>(
        string filePath,
        TValue emptyValue,
        Func<Document, Task<TValue>> resolve,
        CancellationToken ct
    )
    {
        return RunQueryAsync(() => FindDocumentAsync(filePath, ct), emptyValue, resolve);
    }

    /// <summary>
    /// The skeleton every query shares: find what it runs on, answer <paramref name="empty"/>
    /// when there is nothing, else run <paramref name="query"/>. Any exception becomes a
    /// failure carrying its message.
    /// </summary>
    private static async Task<Outcome.Result<TValue, string>> RunQueryAsync<TSubject, TValue>(
        Func<Task<TSubject?>> find,
        TValue empty,
        Func<TSubject, Task<TValue>> query
    )
        where TSubject : class
    {
        try
        {
            var subject = await find().ConfigureAwait(false);
            var value = subject is null ? empty : await query(subject).ConfigureAwait(false);
            return new Outcome.Result<TValue, string>.Ok<TValue, string>(value);
        }
        catch (Exception ex)
        {
            return Outcome.Result<TValue, string>.Failure(ex.Message);
        }
    }

    /// <summary>
    /// A position query that searches beyond the document: <paramref name="resolve"/> also
    /// gets each project's active framework to search, and its locations come back mapped
    /// out of Razor projections. [NETFX-PROJECTS-CSHARP] [RAZOR-FEATURES-REFERENCES]
    /// </summary>
    private Task<Outcome.Result<LocationListResult, string>> RunScopedLocationQueryAsync(
        string filePath,
        (int Line, int Character) at,
        Func<QueryTarget, SearchScope, Task<LocationListResult>> resolve,
        CancellationToken ct
    )
    {
        return RunPositionQueryAsync(
            filePath,
            at,
            new LocationListResult(),
            async target =>
            {
                var scope = await SearchScope
                    .OfAsync(target.Document, _activeFrameworks, ct)
                    .ConfigureAwait(false);
                var found = await resolve(target, scope).ConfigureAwait(false);
                return await MapLocationsAsync(found, ct).ConfigureAwait(false);
            },
            ct
        );
    }

    /// <summary>
    /// <see cref="RunDocumentQueryAsync{TValue}"/> for a query that searches beyond the
    /// document: <paramref name="resolve"/> also gets each project's active framework to
    /// search. [NETFX-PROJECTS-CSHARP]
    /// </summary>
    private Task<Outcome.Result<TValue, string>> RunScopedQueryAsync<TValue>(
        string filePath,
        TValue emptyValue,
        Func<Document, SearchScope, Task<TValue>> resolve,
        CancellationToken ct
    )
    {
        return RunDocumentQueryAsync(
            filePath,
            emptyValue,
            async document =>
                await resolve(
                        document,
                        await SearchScope
                            .OfAsync(document, _activeFrameworks, ct)
                            .ConfigureAwait(false)
                    )
                    .ConfigureAwait(false),
            ct
        );
    }
}
