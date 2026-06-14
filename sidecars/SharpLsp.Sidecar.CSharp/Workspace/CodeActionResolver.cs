using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CodeRefactorings;
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

        var diagnostics = model
            .GetDiagnostics(span, ct)
            .Where(d => d.Severity != DiagnosticSeverity.Hidden)
            .ToImmutableArray();

        if (diagnostics.IsEmpty)
        {
            return;
        }

        var diagById = diagnostics
            .GroupBy(d => d.Id)
            .ToDictionary(g => g.Key, g => g.ToImmutableArray());

        foreach (var provider in CachedFixProviders.Value)
        {
            ct.ThrowIfCancellationRequested();
            await TryRegisterFixesAsync(provider, document, diagById, items, ct)
                .ConfigureAwait(false);
        }
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

            foreach (var diag in matchingDiags)
            {
                try
                {
                    var context = new CodeFixContext(
                        document,
                        diag,
                        (action, _) => CacheAndAdd(action, "quickfix", items),
                        ct
                    );
                    await provider.RegisterCodeFixesAsync(context).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    Log.Debug(
                        ex,
                        "[CodeAction] Fix provider {Provider} failed",
                        provider.GetType().Name
                    );
                }
            }
        }
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
            try
            {
                var context = new CodeRefactoringContext(
                    document,
                    span,
                    action => CacheAndAdd(action, "refactor", items),
                    ct
                );
                await provider.ComputeRefactoringsAsync(context).ConfigureAwait(false);
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
    }

    private void CacheAndAdd(CodeAction action, string kind, List<CodeActionItem> items)
    {
        // Flatten nested actions (e.g. "Fix all occurrences in...").
        if (action.NestedActions.Length > 0)
        {
            foreach (var nested in action.NestedActions)
            {
                CacheAndAdd(nested, kind, items);
            }

            return;
        }

        var id = Interlocked.Increment(ref _nextId);
        _pendingActions[id] = action;
        items.Add(
            new CodeActionItem
            {
                Id = id,
                Title = action.Title,
                Kind = kind,
                IsPreferred = action.Priority == CodeActionPriority.High,
            }
        );
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
            var oldDoc = oldSolution.GetDocument(docId);
            var newDoc = newSolution.GetDocument(docId);
            if (oldDoc is null || newDoc is null)
            {
                continue;
            }

            var edits = await ComputeTextEditsAsync(oldDoc, newDoc, ct).ConfigureAwait(false);
            if (edits.Count > 0 && newDoc.FilePath is not null)
            {
                result.DocumentChanges.Add(
                    new DocumentEditResult { FilePath = newDoc.FilePath, Edits = edits }
                );
            }
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
            var newDoc = newSolution.GetDocument(docId);
            if (newDoc?.FilePath is null)
            {
                continue;
            }

            var text = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
            result.DocumentChanges.Add(
                new DocumentEditResult
                {
                    FilePath = newDoc.FilePath,
                    Edits =
                    [
                        new TextEditResult
                        {
                            StartLine = 0,
                            StartCharacter = 0,
                            EndLine = 0,
                            EndCharacter = 0,
                            NewText = text.ToString(),
                        },
                    ],
                }
            );
        }
    }

    private static async Task<List<TextEditResult>> ComputeTextEditsAsync(
        Document oldDoc,
        Document newDoc,
        CancellationToken ct
    )
    {
        var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
        var newText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
        var textChanges = newText.GetTextChanges(oldText);

        var edits = new List<TextEditResult>();
        foreach (var change in textChanges)
        {
            var start = oldText.Lines.GetLinePosition(change.Span.Start);
            var end = oldText.Lines.GetLinePosition(change.Span.End);
            edits.Add(
                new TextEditResult
                {
                    StartLine = start.Line,
                    StartCharacter = start.Character,
                    EndLine = end.Line,
                    EndCharacter = end.Character,
                    NewText = change.NewText ?? "",
                }
            );
        }

        return edits;
    }

    private static ImmutableArray<CodeFixProvider> LoadFixProviders()
    {
        return DiscoverProviders<CodeFixProvider>();
    }

    private static ImmutableArray<CodeRefactoringProvider> LoadRefactoringProviders()
    {
        return DiscoverProviders<CodeRefactoringProvider>();
    }

    private static ImmutableArray<T> DiscoverProviders<T>()
        where T : class
    {
        var providers = new List<T>();
        foreach (var assembly in GetFeatureAssemblies())
        {
            CollectProvidersFromAssembly(assembly, providers);
        }

        Log.Debug(
            "[CodeAction] Discovered {Count} {ProviderType} providers",
            providers.Count,
            typeof(T).Name
        );
        return [.. providers];
    }

    private static void CollectProvidersFromAssembly<T>(Assembly assembly, List<T> providers)
        where T : class
    {
        try
        {
            foreach (var type in assembly.DefinedTypes)
            {
                TryInstantiateProvider(type, providers);
            }
        }
        catch (ReflectionTypeLoadException ex)
        {
            // Assembly has unresolvable types — skip it, noting why (file log only).
            Log.Debug(
                ex,
                "[CodeAction] Skipped assembly {Assembly} (unresolvable types)",
                assembly.GetName().Name
            );
        }
    }

    private static void TryInstantiateProvider<T>(
        System.Reflection.TypeInfo type,
        List<T> providers
    )
        where T : class
    {
        if (type.IsAbstract || type.IsInterface || !typeof(T).IsAssignableFrom(type))
        {
            return;
        }

        try
        {
            if (Activator.CreateInstance(type) is T provider)
            {
                providers.Add(provider);
            }
        }
        catch
        {
            // Some providers need MEF dependencies — skip them.
        }
    }

    private static Assembly[] GetFeatureAssemblies()
    {
        try
        {
            return
            [
                Assembly.Load("Microsoft.CodeAnalysis.Features"),
                Assembly.Load("Microsoft.CodeAnalysis.CSharp.Features"),
            ];
        }
        catch
        {
            return [];
        }
    }
}
