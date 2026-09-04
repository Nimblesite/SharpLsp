using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers Roslyn code fix and refactoring providers via reflection,
/// enumerates available code actions for a range, and resolves them to edits.
/// </summary>
internal sealed class CodeActionResolver
{
    private static readonly Lazy<ImmutableArray<CodeFixProvider>> CachedFixProviders = new(
        LoadFixProviders
    );

    private static readonly Lazy<
        ImmutableArray<CodeRefactoringProvider>
    > CachedRefactoringProviders = new(LoadRefactoringProviders);

    private static readonly Lazy<ImmutableArray<DiagnosticAnalyzer>> CachedDiagnosticAnalyzers =
        new(() => AnalyzerDiagnosticResolver.DiscoverFixableAnalyzers(CachedFixProviders.Value));

    private static readonly ImmutableHashSet<string> RewriteDiagnosticIds = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "IDE0007",
        "IDE0008",
        "IDE0160",
        "IDE0161"
    );

    private readonly ConcurrentDictionary<int, CodeAction> _pendingActions = new();
    private int _nextId;

    /// <summary>
    /// Get available code actions (fixes + refactorings) for a document range.
    /// Caches the underlying CodeAction objects for subsequent resolve calls.
    /// </summary>
    public async Task<List<CodeActionItem>> GetCodeActionsAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var items = new List<CodeActionItem>();
        await CollectCodeFixesAsync(document, span, items, ct).ConfigureAwait(false);
        await CollectHeadlessOverridesAsync(document, span, items, ct).ConfigureAwait(false);
        await CollectRefactoringsAsync(document, span, items, ct).ConfigureAwait(false);
        return items;
    }

    /// <summary>
    /// Resolve a previously cached code action by ID, returning workspace edits.
    /// </summary>
    public async Task<WorkspaceEditResult?> ResolveAsync(
        int actionId,
        Solution originalSolution,
        CancellationToken ct
    )
    {
        if (!_pendingActions.TryRemove(actionId, out var codeAction))
        {
            return null;
        }

        var operations = await codeAction.GetOperationsAsync(ct).ConfigureAwait(false);
        var applyOp = operations.OfType<ApplyChangesOperation>().FirstOrDefault();
        return applyOp is null
            ? new WorkspaceEditResult()
            : await BuildWorkspaceEditAsync(originalSolution, applyOp.ChangedSolution, ct)
                .ConfigureAwait(false);
    }

    private async Task CollectCodeFixesAsync(
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return;
        }

        await CollectResolvedFixesAsync(document, model, span, items, ct).ConfigureAwait(false);
    }

    private async Task CollectResolvedFixesAsync(
        Document document,
        SemanticModel model,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        var diagnostics = await ResolveDiagnosticsAsync(document, model, span, ct)
            .ConfigureAwait(false);
        if (diagnostics.IsEmpty)
        {
            return;
        }

        await RegisterFixProvidersAsync(document, GroupDiagnostics(diagnostics), items, ct)
            .ConfigureAwait(false);
    }

    private async Task RegisterFixProvidersAsync(
        Document document,
        Dictionary<string, ImmutableArray<Diagnostic>> diagnostics,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        foreach (var provider in CachedFixProviders.Value)
        {
            ct.ThrowIfCancellationRequested();
            await TryRegisterFixesAsync(provider, document, diagnostics, items, ct)
                .ConfigureAwait(false);
        }
    }

    private static Dictionary<string, ImmutableArray<Diagnostic>> GroupDiagnostics(
        ImmutableArray<Diagnostic> diagnostics
    )
    {
        return diagnostics
            .GroupBy(diagnostic => diagnostic.Id)
            .ToDictionary(group => group.Key, group => group.ToImmutableArray());
    }

    private static async Task<ImmutableArray<Diagnostic>> ResolveDiagnosticsAsync(
        Document document,
        SemanticModel model,
        TextSpan span,
        CancellationToken ct
    )
    {
        var analyzerDiagnostics = await AnalyzerDiagnosticResolver
            .ResolveAsync(document, model, span, CachedDiagnosticAnalyzers.Value, ct)
            .ConfigureAwait(false);
        return model.GetDiagnostics(span, ct).AddRange(analyzerDiagnostics);
    }

    private async Task TryRegisterFixesAsync(
        CodeFixProvider provider,
        Document document,
        Dictionary<string, ImmutableArray<Diagnostic>> diagById,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        foreach (var fixableId in provider.FixableDiagnosticIds)
        {
            if (!diagById.TryGetValue(fixableId, out var matchingDiags))
            {
                continue;
            }

            await RegisterMatchingFixesAsync(provider, document, matchingDiags, items, ct)
                .ConfigureAwait(false);
        }
    }

    private async Task RegisterMatchingFixesAsync(
        CodeFixProvider provider,
        Document document,
        ImmutableArray<Diagnostic> diagnostics,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        foreach (var diagnostic in diagnostics)
        {
            await TryRegisterFixAsync(provider, document, diagnostic, items, ct)
                .ConfigureAwait(false);
        }
    }

    private async Task TryRegisterFixAsync(
        CodeFixProvider provider,
        Document document,
        Diagnostic diagnostic,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        try
        {
            await RegisterFixCoreAsync(provider, document, diagnostic, items, ct)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[CodeAction] Fix provider {Provider} failed", provider.GetType().Name);
        }
    }

    private async Task RegisterFixCoreAsync(
        CodeFixProvider provider,
        Document document,
        Diagnostic diagnostic,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        var context = CreateFixContext(document, diagnostic, items, ct);
        await provider.RegisterCodeFixesAsync(context).ConfigureAwait(false);
    }

    private CodeFixContext CreateFixContext(
        Document document,
        Diagnostic diagnostic,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        return new CodeFixContext(
            document,
            diagnostic,
            (action, _) => CacheAndAdd(action, FixKind(diagnostic.Id), items, null),
            ct
        );
    }

    private async Task CollectHeadlessOverridesAsync(
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        var action = await HeadlessOverrideCodeAction
            .TryCreateAsync(document, span, ct)
            .ConfigureAwait(false);
        if (action is not null)
        {
            CacheAndAdd(action, "refactor.rewrite", items, null);
        }
    }

    private static string FixKind(string diagnosticId)
    {
        return RewriteDiagnosticIds.Contains(diagnosticId) ? "refactor.rewrite" : "quickfix";
    }

    private async Task CollectRefactoringsAsync(
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        foreach (var provider in CachedRefactoringProviders.Value)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var query in QuerySpans(span))
            {
                await TryRegisterRefactoringAsync(provider, document, query, items, ct)
                    .ConfigureAwait(false);
            }
        }
    }

    /// <summary>The spans one Ctrl-. asks every provider about.</summary>
    /// <remarks>
    /// Roslyn finds a refactoring's target with `TryGetRelevantNode`, which needs
    /// the span to sit inside ONE node, so a selection over an invocation's method
    /// name resolves to the identifier rather than to the invocation. The
    /// collapsed caret is asked as well, second, so where both answer the user's
    /// own selection is the one that survives deduplication.
    /// </remarks>
    private static IEnumerable<TextSpan> QuerySpans(TextSpan span)
    {
        yield return span;
        if (!span.IsEmpty)
        {
            yield return new TextSpan(span.Start, 0);
        }
    }

    private async Task TryRegisterRefactoringAsync(
        CodeRefactoringProvider provider,
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        try
        {
            await provider
                .ComputeRefactoringsAsync(
                    CreateRefactoringContext(provider, document, span, items, ct)
                )
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            Log.Debug(
                ex,
                "[CodeAction] Refactoring provider {Provider} failed",
                provider.GetType().Name
            );
        }
    }

    private CodeRefactoringContext CreateRefactoringContext(
        CodeRefactoringProvider provider,
        Document document,
        TextSpan span,
        List<CodeActionItem> items,
        CancellationToken ct
    )
    {
        return new CodeRefactoringContext(
            document,
            span,
            action => CacheAndAdd(action, RefactoringKind(provider, action), items, null),
            ct
        );
    }

    private static string RefactoringKind(CodeRefactoringProvider provider, CodeAction action)
    {
        var providerName = provider.GetType().Name;
        return IsOrganizeImports(providerName, action.Title) ? "source.organizeImports"
            : providerName.Contains("Inline", StringComparison.OrdinalIgnoreCase)
                ? "refactor.inline"
            : IsExtractionProvider(providerName) ? "refactor.extract"
            : "refactor.rewrite";
    }

    private static bool IsOrganizeImports(string providerName, string title)
    {
        return providerName.Contains("OrganizeImports", StringComparison.OrdinalIgnoreCase)
            || title.Equals("Organize Imports", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsExtractionProvider(string providerName)
    {
        return providerName.Contains("Extract", StringComparison.OrdinalIgnoreCase)
            || providerName.Contains("IntroduceLocal", StringComparison.OrdinalIgnoreCase)
            || providerName.Contains("IntroduceVariable", StringComparison.OrdinalIgnoreCase)
            || providerName.Contains("IntroduceConstant", StringComparison.OrdinalIgnoreCase)
            || providerName.Contains("IntroduceField", StringComparison.OrdinalIgnoreCase);
    }

    private void CacheAndAdd(
        CodeAction action,
        string kind,
        List<CodeActionItem> items,
        string? parentTitle
    )
    {
        var title = Qualified(parentTitle, action.Title);
        if (CacheNestedActions(action, kind, items, title) || IsDuplicate(title, kind, items))
        {
            return;
        }

        items.Add(CacheAction(action, kind, title));
    }

    private bool CacheNestedActions(
        CodeAction action,
        string kind,
        List<CodeActionItem> items,
        string title
    )
    {
        if (action.NestedActions.IsEmpty)
        {
            return false;
        }

        foreach (var nested in action.NestedActions)
        {
            CacheAndAdd(nested, kind, items, title);
        }

        return true;
    }

    /// <summary>
    /// A flattened child's title, carrying the container it came from when it
    /// cannot stand without it.
    /// </summary>
    /// <remarks>
    /// LSP has no submenus, so a nested action arrives in the same flat list as
    /// every other and its title is all the user reads before choosing. Roslyn
    /// writes children in two shapes: sentences that name themselves ("Inline
    /// and keep 'X'", "Convert to binary") and continuations of the PARENT's
    /// sentence ("and update call sites directly", "into new overload") that say
    /// nothing alone. Only the continuations are joined, and with a space, so
    /// the result reads as the sentence Roslyn actually wrote. Renaming the
    /// self-contained ones would only make them stutter.
    /// </remarks>
    private static string Qualified(string? parentTitle, string title)
    {
        return string.IsNullOrEmpty(parentTitle) || !IsContinuation(title)
            ? title
            : parentTitle + " " + title;
    }

    /// <summary>
    /// Whether a child's title continues its parent's sentence instead of
    /// naming itself. Roslyn writes those in lower case, and only those.
    /// </summary>
    private static bool IsContinuation(string title)
    {
        return title.Length > 0 && char.IsLower(title[0]);
    }

    private static bool IsDuplicate(string title, string kind, List<CodeActionItem> items)
    {
        return items.Any(item => item.Title == title && item.Kind == kind);
    }

    private CodeActionItem CacheAction(CodeAction action, string kind, string title)
    {
        var id = Interlocked.Increment(ref _nextId);
        _pendingActions[id] = action;
        return new CodeActionItem
        {
            Id = id,
            Title = title,
            Kind = kind,
            IsPreferred = action.Priority == CodeActionPriority.High,
        };
    }

    private static async Task<WorkspaceEditResult> BuildWorkspaceEditAsync(
        Solution oldSolution,
        Solution newSolution,
        CancellationToken ct
    )
    {
        var result = new WorkspaceEditResult();
        var changes = newSolution.GetChanges(oldSolution);

        foreach (var projectChange in changes.GetProjectChanges())
        {
            await CollectChangedDocumentsAsync(oldSolution, newSolution, projectChange, result, ct)
                .ConfigureAwait(false);
            await CollectAddedDocumentsAsync(newSolution, projectChange, result, ct)
                .ConfigureAwait(false);
        }

        return result;
    }

    private static async Task CollectChangedDocumentsAsync(
        Solution oldSolution,
        Solution newSolution,
        ProjectChanges projectChange,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        foreach (var docId in projectChange.GetChangedDocuments())
        {
            await CollectChangedDocumentAsync(oldSolution, newSolution, docId, result, ct)
                .ConfigureAwait(false);
        }
    }

    private static async Task CollectChangedDocumentAsync(
        Solution oldSolution,
        Solution newSolution,
        DocumentId docId,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        var oldDoc = oldSolution.GetDocument(docId);
        var newDoc = newSolution.GetDocument(docId);
        if (oldDoc is null || newDoc?.FilePath is null)
        {
            return;
        }

        var edits = await DocumentText.ComputeEditsAsync(oldDoc, newDoc, ct).ConfigureAwait(false);
        if (edits.Count > 0)
        {
            result.DocumentChanges.Add(
                new DocumentEditResult { FilePath = newDoc.FilePath, Edits = edits }
            );
        }
    }

    private static async Task CollectAddedDocumentsAsync(
        Solution newSolution,
        ProjectChanges projectChange,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        foreach (var docId in projectChange.GetAddedDocuments())
        {
            await CollectAddedDocumentAsync(newSolution, docId, result, ct).ConfigureAwait(false);
        }
    }

    private static async Task CollectAddedDocumentAsync(
        Solution solution,
        DocumentId docId,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        var document = solution.GetDocument(docId);
        if (document?.FilePath is null)
        {
            return;
        }

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        result.DocumentChanges.Add(CreateAddedDocumentEdit(document.FilePath, text.ToString()));
    }

    private static DocumentEditResult CreateAddedDocumentEdit(string filePath, string text)
    {
        return new DocumentEditResult
        {
            FilePath = filePath,
            Edits = [CreateWholeDocumentEdit(text)],
        };
    }

    private static TextEditResult CreateWholeDocumentEdit(string text)
    {
        return new TextEditResult
        {
            StartLine = 0,
            StartCharacter = 0,
            EndLine = 0,
            EndCharacter = 0,
            NewText = text,
        };
    }

    private static ImmutableArray<CodeFixProvider> LoadFixProviders()
    {
        return AnalyzerDiagnosticResolver.DiscoverProviders<CodeFixProvider>();
    }

    private static ImmutableArray<CodeRefactoringProvider> LoadRefactoringProviders()
    {
        return
        [
            .. AnalyzerDiagnosticResolver.DiscoverProviders<CodeRefactoringProvider>(),
            new MergeDeclarationAssignmentCodeRefactoringProvider(),
        ];
    }
}
