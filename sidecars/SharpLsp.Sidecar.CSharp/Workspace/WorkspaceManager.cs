using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Outcome;
using SharpLsp.Sidecar.CSharp.Hover;
using AllDiagnosticsResult = Outcome.Result<
    System.Collections.Generic.Dictionary<
        string,
        System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>
    >,
    string
>;
using CodeActionsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CodeActionItem>,
    string
>;
using CompletionsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CompletionItem>,
    string
>;
using DefinitionResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationResult?, string>;
using DiagnosticsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>,
    string
>;
using HighlightsResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.DocumentHighlightListResult,
    string
>;
using HoverQueryResult = Outcome.Result<SharpLsp.Sidecar.CSharp.HoverResult?, string>;
using ImplementationsResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;
using PrepareRenameQueryResult = Outcome.Result<SharpLsp.Sidecar.CSharp.PrepareRenameResult, string>;
using ReferencesResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;
using RenameEditResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;
using ResolveResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;
using VoidResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Manages the Roslyn MSBuildWorkspace lifecycle.
/// Provides semantic operations: diagnostics, completions, hover, go-to-definition.
/// </summary>
internal sealed partial class WorkspaceManager : IDisposable
{
    private MSBuildWorkspace? _workspace;
    private Solution? _solution;
    private readonly CodeActionResolver _codeActionResolver = new();

    // Roslyn's Solution is immutable; mutating _solution = _solution.WithX(...)
    // is a non-atomic read-modify-write. Concurrent didChange and workspace-load
    // mutations would drop edits, leaving Roslyn with stale text.
    private readonly SemaphoreSlim _solutionMutationLock = new(1, 1);

    public void Dispose()
    {
        _workspace?.Dispose();
        _solutionMutationLock.Dispose();
    }

    // Pending text edits keyed by file path that arrived BEFORE the workspace
    // finished loading. We replay them after OpenAsync completes so live edits
    // sent during workspace warmup aren't silently lost.
    private readonly Dictionary<string, string> _pendingTextEdits = new(
        StringComparer.OrdinalIgnoreCase
    );

    public bool IsLoaded => _solution is not null;

    /// <summary>Open a solution or project file via MSBuildWorkspace.</summary>
    [Obsolete("Placeholder until workspace loading is redesigned")]
    public async Task<VoidResult> OpenAsync(string path, CancellationToken ct = default)
    {
        try
        {
            return await OpenCoreAsync(path, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return VoidResult.Failure(ex.Message);
        }
    }

    /// <summary>Update the in-memory text for a document (live editing).</summary>
    public async Task<VoidResult> UpdateDocumentTextAsync(
        string filePath,
        string newText,
        CancellationToken ct = default
    )
    {
        try
        {
            await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_solution is null)
                {
                    // Workspace still loading. Stash the edit; OpenAsync will
                    // replay it once the solution is materialized.
                    _pendingTextEdits[filePath] = newText;
                    return new VoidResult.Ok<Unit, string>(Unit.Value);
                }

                var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
                if (document is null)
                {
                    return VoidResult.Failure($"Document not found: {filePath}");
                }

                _solution = _solution.WithDocumentText(document.Id, SourceText.From(newText));
                return new VoidResult.Ok<Unit, string>(Unit.Value);
            }
            finally
            {
                _ = _solutionMutationLock.Release();
            }
        }
        catch (Exception ex)
        {
            return VoidResult.Failure(ex.Message);
        }
    }

    /// <summary>Get compiler diagnostics for a file.</summary>
    public async Task<DiagnosticsResult> GetDiagnosticsAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>([]);
            }

            var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
            return model is null
                ? new DiagnosticsResult.Ok<List<DiagnosticResult>, string>([])
                : new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(
                    MapDiagnostics(filePath, model, ct)
                );
        }
        catch (Exception ex)
        {
            return DiagnosticsResult.Failure(ex.Message);
        }
    }

    /// <summary>Get compiler diagnostics for all files in the solution.</summary>
    /// <remarks>
    /// Iterates projects in topological (dependency) order so each project's
    /// compilation is built AFTER its referenced projects. Without this,
    /// Roslyn's lazy compilation produces phantom CS0246/CS0234 errors when
    /// a consumer project is compiled before its dependencies are cached
    /// as CompilationReferences. SharpLsp does not lie about compilation state.
    /// </remarks>
    public async Task<AllDiagnosticsResult> GetAllDiagnosticsAsync(
        string[] projectFilter,
        CancellationToken ct = default
    )
    {
        try
        {
            if (_solution is null)
            {
                return new AllDiagnosticsResult.Ok<
                    Dictionary<string, List<DiagnosticResult>>,
                    string
                >(new Dictionary<string, List<DiagnosticResult>>());
            }

            var results = new Dictionary<string, List<DiagnosticResult>>();
            var filteredProjects = FilterProjects(projectFilter).ToHashSet();
            var orderedProjects = OrderProjectsByDependencies(_solution, filteredProjects, ct);

            foreach (var project in orderedProjects)
            {
                ct.ThrowIfCancellationRequested();
                await CollectProjectDiagnosticsAsync(project, results, ct).ConfigureAwait(false);
            }

            return new AllDiagnosticsResult.Ok<Dictionary<string, List<DiagnosticResult>>, string>(
                results
            );
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return AllDiagnosticsResult.Failure(ex.Message);
        }
    }

    /// <summary>
    /// Return the given projects ordered topologically (dependencies first,
    /// consumers last) so `GetCompilationAsync` on consumers sees already-built
    /// dependency compilations as CompilationReferences.
    /// </summary>
    private static IEnumerable<Project> OrderProjectsByDependencies(
        Solution solution,
        HashSet<Project> filtered,
        CancellationToken ct
    )
    {
        var graph = solution.GetProjectDependencyGraph();
        foreach (var projectId in graph.GetTopologicallySortedProjects(ct))
        {
            var project = solution.GetProject(projectId);
            if (project is not null && filtered.Contains(project))
            {
                yield return project;
            }
        }
    }

    /// <summary>Get completion items at a position.</summary>
    public async Task<CompletionsResult> GetCompletionsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var items = await GetCompletionsCoreAsync(filePath, line, character, ct)
                .ConfigureAwait(false);
            return new CompletionsResult.Ok<List<CompletionItem>, string>(items);
        }
        catch (Exception ex)
        {
            return CompletionsResult.Failure(ex.Message);
        }
    }

    /// <summary>Get hover information at a position.</summary>
    public async Task<HoverQueryResult> GetHoverAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            await Console
                .Error.WriteLineAsync($"[Hover] GetHoverAsync: {filePath}:{line}:{character}")
                .ConfigureAwait(false);
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                await Console
                    .Error.WriteLineAsync($"[Hover] Document not found: {filePath}")
                    .ConfigureAwait(false);
                return new HoverQueryResult.Ok<HoverResult?, string>(null);
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var position = text.Lines.GetPosition(new LinePosition(line, character));
            var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model is null)
            {
                await Console
                    .Error.WriteLineAsync($"[Hover] Semantic model is null: {filePath}")
                    .ConfigureAwait(false);
                return new HoverQueryResult.Ok<HoverResult?, string>(null);
            }

            var result = CSharpHoverBuilder.Build(model, position, ct);
            await Console
                .Error.WriteLineAsync(
                    $"[Hover] Result: {(result is HoverQueryResult.Ok<HoverResult?, string> { Value: not null } ? "content" : "null")}"
                )
                .ConfigureAwait(false);
            return result;
        }
        catch (Exception ex)
        {
            await Console
                .Error.WriteLineAsync($"[Hover] Exception: {ex.Message}")
                .ConfigureAwait(false);
            return HoverQueryResult.Failure(ex.Message);
        }
    }

    /// <summary>Go to definition at a position (returns all locations for partial types).</summary>
    public async Task<ImplementationsResult> GetDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new ImplementationsResult.Ok<LocationListResult, string>(
                    new LocationListResult()
                );
            }

            var result = await DefinitionResolver
                .ResolveDefinitionLocationsAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new ImplementationsResult.Ok<LocationListResult, string>(result);
        }
        catch (Exception ex)
        {
            return ImplementationsResult.Failure(ex.Message);
        }
    }

    /// <summary>Go to type definition at a position.</summary>
    public async Task<DefinitionResult> GetTypeDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new DefinitionResult.Ok<LocationResult?, string>(null);
            }

            var location = await DefinitionResolver
                .ResolveTypeDefinitionAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new DefinitionResult.Ok<LocationResult?, string>(location);
        }
        catch (Exception ex)
        {
            return DefinitionResult.Failure(ex.Message);
        }
    }

    /// <summary>Go to declaration (interface/base member) at a position.</summary>
    public async Task<DefinitionResult> GetDeclarationAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new DefinitionResult.Ok<LocationResult?, string>(null);
            }

            var location = await DefinitionResolver
                .ResolveDeclarationAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new DefinitionResult.Ok<LocationResult?, string>(location);
        }
        catch (Exception ex)
        {
            return DefinitionResult.Failure(ex.Message);
        }
    }

    /// <summary>Find all implementations of symbol at a position.</summary>
    public async Task<ImplementationsResult> GetImplementationsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return new ImplementationsResult.Ok<LocationListResult, string>(
                    new LocationListResult()
                );
            }

            var result = await DefinitionResolver
                .ResolveImplementationsAsync(document, _solution, line, character, ct)
                .ConfigureAwait(false);
            return new ImplementationsResult.Ok<LocationListResult, string>(result);
        }
        catch (Exception ex)
        {
            return ImplementationsResult.Failure(ex.Message);
        }
    }

    public async Task<ReferencesResult> GetReferencesAsync(
        string filePath,
        int line,
        int character,
        bool includeDeclaration,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return new ReferencesResult.Ok<LocationListResult, string>(
                    new LocationListResult()
                );
            }

            var result = await DefinitionResolver
                .ResolveReferencesAsync(
                    document,
                    _solution,
                    line,
                    character,
                    includeDeclaration,
                    ct
                )
                .ConfigureAwait(false);
            return new ReferencesResult.Ok<LocationListResult, string>(result);
        }
        catch (Exception ex)
        {
            return ReferencesResult.Failure(ex.Message);
        }
    }

    /// <summary>Get available code actions (fixes + refactorings) for a range.</summary>
    public async Task<CodeActionsResult> GetCodeActionsAsync(
        string filePath,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new CodeActionsResult.Ok<List<CodeActionItem>, string>([]);
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var startPos = text.Lines.GetPosition(new LinePosition(startLine, startCharacter));
            var endPos = text.Lines.GetPosition(new LinePosition(endLine, endCharacter));
            var span = TextSpan.FromBounds(startPos, Math.Max(startPos, endPos));

            var items = await _codeActionResolver
                .GetCodeActionsAsync(document, span, ct)
                .ConfigureAwait(false);
            return new CodeActionsResult.Ok<List<CodeActionItem>, string>(items);
        }
        catch (Exception ex)
        {
            return CodeActionsResult.Failure(ex.Message);
        }
    }

    /// <summary>Resolve a code action by ID to a workspace edit.</summary>
    public async Task<ResolveResult> ResolveCodeActionAsync(
        int actionId,
        CancellationToken ct = default
    )
    {
        try
        {
            if (_solution is null)
            {
                return ResolveResult.Failure("No solution loaded");
            }

            var result = await _codeActionResolver
                .ResolveAsync(actionId, _solution, ct)
                .ConfigureAwait(false);
            return result is null
                ? ResolveResult.Failure($"Code action {actionId} not found")
                : new ResolveResult.Ok<WorkspaceEditResult, string>(result);
        }
        catch (Exception ex)
        {
            return ResolveResult.Failure(ex.Message);
        }
    }

    public async Task<HighlightsResult> GetDocumentHighlightsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return new HighlightsResult.Ok<DocumentHighlightListResult, string>(
                    new DocumentHighlightListResult()
                );
            }

            var highlights = await DefinitionResolver
                .ResolveDocumentHighlightsAsync(document, _solution, line, character, ct)
                .ConfigureAwait(false);
            return new HighlightsResult.Ok<DocumentHighlightListResult, string>(
                new DocumentHighlightListResult { Highlights = highlights }
            );
        }
        catch (Exception ex)
        {
            return HighlightsResult.Failure(ex.Message);
        }
    }

    private async Task<VoidResult> OpenCoreAsync(string path, CancellationToken ct)
    {
        var properties = new Dictionary<string, string>
        {
            ["DesignTimeBuild"] = "true",
            ["BuildingInsideVisualStudio"] = "true",
            ["SkipCompilerExecution"] = "true",
        };

        _workspace = MSBuildWorkspace.Create(properties);
        _ = _workspace.RegisterWorkspaceFailedHandler(args =>
            Console.Error.WriteLine($"Workspace warning: {args.Diagnostic.Message}")
        );

        var findResult = SolutionLoader.FindSolutionOrProject(path);
        if (findResult.IsError)
        {
            return VoidResult.Failure(!findResult ?? "Search failed");
        }

        var target =
            findResult.Match(value => value, _ => null)
            ?? throw new FileNotFoundException(
                $"No .sln, .slnx, or .csproj found at or under '{path}'."
            );

        var loaded = await LoadSolutionOrProjectAsync(target, ct).ConfigureAwait(false);

        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _solution = loaded;
            ReplayPendingTextEdits();
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }

        await Console
            .Error.WriteLineAsync($"Loaded {_solution.ProjectIds.Count} project(s) from {target}")
            .ConfigureAwait(false);

        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    /// <summary>
    /// Replay any didChange edits that arrived before the workspace finished
    /// loading. Caller must hold <see cref="_solutionMutationLock" />.
    /// </summary>
    private void ReplayPendingTextEdits()
    {
        if (_pendingTextEdits.Count == 0 || _solution is null)
        {
            return;
        }

        foreach (var (filePath, newText) in _pendingTextEdits)
        {
            var normalizedPath = Path.GetFullPath(filePath);
            var documentId = FindDocumentIdByPath(normalizedPath);
            if (documentId is not null)
            {
                _solution = _solution.WithDocumentText(documentId, SourceText.From(newText));
            }
        }
        _pendingTextEdits.Clear();
    }

    private DocumentId? FindDocumentIdByPath(string normalizedPath)
    {
        foreach (var project in _solution!.Projects)
        {
            foreach (var document in project.Documents)
            {
                if (IsPathMatch(document.FilePath, normalizedPath))
                {
                    return document.Id;
                }
            }
        }
        return null;
    }

    private async Task<Solution> LoadSolutionOrProjectAsync(string target, CancellationToken ct)
    {
        // Roslyn 5.x's MSBuildWorkspace.OpenSolutionAsync handles both
        // legacy .sln and the XML-based .slnx format.
        if (
            target.EndsWith(".sln", StringComparison.OrdinalIgnoreCase)
            || target.EndsWith(".slnx", StringComparison.OrdinalIgnoreCase)
        )
        {
            return await _workspace!
                .OpenSolutionAsync(target, cancellationToken: ct)
                .ConfigureAwait(false);
        }

        var project = await _workspace!
            .OpenProjectAsync(target, cancellationToken: ct)
            .ConfigureAwait(false);
        return project.Solution;
    }

    // Implements [RENAME-PREPARE]
    /// <summary>Check whether the symbol at the given position can be renamed.</summary>
    public async Task<PrepareRenameQueryResult> PrepareRenameAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return PrepareRenameQueryResult.Failure("Document not found");
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var position = text.Lines[line].Start + character;
            var symbol = await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder
                .FindSymbolAtPositionAsync(document, position, ct)
                .ConfigureAwait(false);

            if (symbol is null or Microsoft.CodeAnalysis.INamespaceSymbol)
            {
                return new PrepareRenameQueryResult.Ok<PrepareRenameResult, string>(
                    new PrepareRenameResult { CanRename = false }
                );
            }

            var syntaxRoot = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            var token = syntaxRoot?.FindToken(position);
            if (token is null || !token.Value.Span.Contains(position))
            {
                return new PrepareRenameQueryResult.Ok<PrepareRenameResult, string>(
                    new PrepareRenameResult { CanRename = false }
                );
            }

            var span = token.Value.Span;
            var lineSpan = text.Lines.GetLinePositionSpan(span);
            return new PrepareRenameQueryResult.Ok<PrepareRenameResult, string>(
                new PrepareRenameResult
                {
                    CanRename = true,
                    StartLine = lineSpan.Start.Line,
                    StartCharacter = lineSpan.Start.Character,
                    EndLine = lineSpan.End.Line,
                    EndCharacter = lineSpan.End.Character,
                    Placeholder = symbol.Name,
                }
            );
        }
        catch (Exception ex)
        {
            return PrepareRenameQueryResult.Failure(ex.Message);
        }
    }

    // Implements [RENAME-APPLY]
    /// <summary>Rename the symbol at the given position to <paramref name="newName"/>.</summary>
    public async Task<RenameEditResult> RenameAsync(
        string filePath,
        int line,
        int character,
        string newName,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return RenameEditResult.Failure("Document or solution not available");
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var position = text.Lines[line].Start + character;
            var symbol = await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder
                .FindSymbolAtPositionAsync(document, position, ct)
                .ConfigureAwait(false);

            if (symbol is null)
            {
                return new RenameEditResult.Ok<WorkspaceEditResult, string>(
                    new WorkspaceEditResult()
                );
            }

            var renamedSolution = await Microsoft.CodeAnalysis.Rename.Renamer
                .RenameSymbolAsync(_solution, symbol, new Microsoft.CodeAnalysis.Rename.SymbolRenameOptions(), newName, ct)
                .ConfigureAwait(false);

            var changes = renamedSolution.GetChanges(_solution);
            var documentChanges = new List<DocumentEditResult>();
            foreach (var projectChange in changes.GetProjectChanges())
            {
                foreach (var docId in projectChange.GetChangedDocuments())
                {
                    var oldDoc = _solution.GetDocument(docId);
                    var newDoc = renamedSolution.GetDocument(docId);
                    if (oldDoc is null || newDoc is null)
                    {
                        continue;
                    }

                    var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
                    var rawNewText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
                    // Normalize to the same SourceText subtype so GetTextChanges
                    // produces granular diffs rather than a single whole-document replacement.
                    var newText = Microsoft.CodeAnalysis.Text.SourceText.From(
                        rawNewText.ToString(),
                        oldText.Encoding
                    );
                    var textChanges = newText.GetTextChanges(oldText);
                    var edits = textChanges
                        .Select(change =>
                        {
                            var changeSpan = oldText.Lines.GetLinePositionSpan(change.Span);
                            return new TextEditResult
                            {
                                StartLine = changeSpan.Start.Line,
                                StartCharacter = changeSpan.Start.Character,
                                EndLine = changeSpan.End.Line,
                                EndCharacter = changeSpan.End.Character,
                                NewText = change.NewText ?? string.Empty,
                            };
                        })
                        .ToList();

                    if (edits.Count > 0)
                    {
                        documentChanges.Add(
                            new DocumentEditResult
                            {
                                FilePath = oldDoc.FilePath ?? filePath,
                                Edits = edits,
                            }
                        );
                    }
                }
            }

            return new RenameEditResult.Ok<WorkspaceEditResult, string>(
                new WorkspaceEditResult { DocumentChanges = documentChanges }
            );
        }
        catch (Exception ex)
        {
            return RenameEditResult.Failure(ex.Message);
        }
    }
}
