using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Outcome;
using Serilog;
using SharpLsp.Sidecar.Common.Logging;
using SharpLsp.Sidecar.Common.Solutions;
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
using PrepareRenameQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.PrepareRenameResult,
    string
>;
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

    // Distinct workspace-load failure summaries already logged. MSBuild reports
    // the same type-load failure once per project, so de-duplicating prevents the
    // log flood described in issue #78.
    private readonly HashSet<string> _loggedWorkspaceFailures = new(StringComparer.Ordinal);

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
            // Extended-length (`\\?\`) spellings — produced by callers that
            // canonicalize, e.g. Rust's std::fs::canonicalize — break
            // MSBuild's solution loading and relative-path resolution.
            // Normalize at the boundary so every downstream consumer sees the
            // normal form. [GitHub #110]
            var normalized = SharpLsp.Sidecar.Common.NativePaths.NormalizeFullPath(path);
            return await OpenCoreAsync(normalized, ct).ConfigureAwait(false);
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

    private bool _deadCodeEnabled;
    private bool _monorepo;

    /// <summary>
    /// Configure the static analyzers from the host's <c>analyzers/configure</c>
    /// push ([ANALYZERS-CONFIG-IMPL]). Flags persist across workspace re-opens.
    /// Defaults are off so direct test construction never gets dead-code diagnostics
    /// unless explicitly enabled; the host always configures in production.
    /// </summary>
    public void ConfigureAnalyzers(bool deadCode, bool monorepo)
    {
        _deadCodeEnabled = deadCode;
        _monorepo = monorepo;
    }

    /// <summary>
    /// Get diagnostics for a file: FCS-style compiler diagnostics plus, when the
    /// dead-code analyzer is enabled, project-wide unused-symbol diagnostics
    /// (`SLSPC0101`, [ANALYZERS-UNUSED-PUBLIC]).
    /// </summary>
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
            if (model is null)
            {
                return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>([]);
            }

            var diagnostics = MapDiagnostics(filePath, model, ct);
            if (_deadCodeEnabled && _solution is not null)
            {
                var dead = await DeadCodeAnalyzer
                    .AnalyzeAsync(document, _solution, _monorepo, ct)
                    .ConfigureAwait(false);
                diagnostics.AddRange(dead);
            }

            return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(diagnostics);
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
            Log.Debug("[Hover] request {File}:{Line}:{Character}", filePath, line, character);
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                Log.Debug("[Hover] document not found: {File}", filePath);
                return new HoverQueryResult.Ok<HoverResult?, string>(null);
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var position = text.Lines.GetPosition(new LinePosition(line, character));
            var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
            if (model is null)
            {
                Log.Debug("[Hover] semantic model is null: {File}", filePath);
                return new HoverQueryResult.Ok<HoverResult?, string>(null);
            }

            var result = CSharpHoverBuilder.Build(model, position, ct);
            var outcome = result is HoverQueryResult.Ok<HoverResult?, string> { Value: not null }
                ? "content"
                : "null";
            Log.Debug("[Hover] result: {Outcome}", outcome);
            return result;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[Hover] request failed");
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

    public Task<HighlightsResult> GetDocumentHighlightsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync(
            filePath,
            new DocumentHighlightListResult(),
            // A non-null document implies _solution was non-null at lookup time:
            // FindDocumentAsync returns null whenever _solution is null.
            async document => new DocumentHighlightListResult
            {
                Highlights = await DefinitionResolver
                    .ResolveDocumentHighlightsAsync(document, _solution!, line, character, ct)
                    .ConfigureAwait(false),
            },
            ct
        );
    }

    private async Task<VoidResult> OpenCoreAsync(string path, CancellationToken ct)
    {
        var properties = new Dictionary<string, string>
        {
            ["DesignTimeBuild"] = "true",
            ["BuildingInsideVisualStudio"] = "true",
            ["SkipCompilerExecution"] = "true",
        };

        _loggedWorkspaceFailures.Clear();
        _workspace = MSBuildWorkspace.Create(properties);
        _ = _workspace.RegisterWorkspaceFailedHandler(LogWorkspaceFailure);

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
            _solution = AddCrossLanguageMetadataReferences(loaded);
            ReplayPendingTextEdits();
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }

        Log.Information(
            "Loaded {ProjectCount} project(s) from {Target}",
            _solution.ProjectIds.Count,
            target
        );

        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    /// <summary>
    /// Logs an MSBuildWorkspace load failure to the rolling file at debug level.
    /// The raw diagnostic can carry dozens of identical type-load lines and is
    /// reported once per project; we collapse repeats and skip already-seen
    /// summaries so it no longer floods the editor's Output panel (issue #78).
    /// </summary>
    private void LogWorkspaceFailure(WorkspaceDiagnosticEventArgs args)
    {
        var summary = SidecarLog.CollapseRepeatedLines(args.Diagnostic.Message);
        if (_loggedWorkspaceFailures.Add(summary))
        {
            Log.Debug("Workspace load diagnostic: {Diagnostic}", summary);
        }
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
            var documentId = SolutionPaths.FindDocument(_solution, filePath)?.Id;
            if (documentId is not null)
            {
                _solution = _solution.WithDocumentText(documentId, SourceText.From(newText));
            }
        }
        _pendingTextEdits.Clear();
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

    /// <summary>
    /// Replace every cross-language <c>&lt;ProjectReference&gt;</c> with a
    /// metadata reference to the referenced project's built output assembly.
    /// </summary>
    /// <remarks>
    /// Roslyn's <c>MSBuildWorkspace</c> has no F# language service, so it loads a
    /// referenced <c>.fsproj</c> as an <em>empty</em> C# project. That empty
    /// project still carries the F# assembly's name, so it is linked
    /// project-to-project AND its (type-less) compilation shadows the real
    /// built DLL — go-to-definition into F# finds nothing. The fix, per
    /// cross-language reference: drop the empty project-to-project reference,
    /// attach the built DLL as a metadata reference, and remove the orphaned
    /// empty stub project so its assembly identity can no longer shadow the DLL.
    /// The referenced symbol then resolves and <see cref="MetadataNavigator"/>
    /// decompiles it to a navigable location. Same-language (.csproj) references
    /// are already linked correctly and are left untouched. Implements
    /// [DEFINITION-CROSSLANG].
    /// </remarks>
    private static Solution AddCrossLanguageMetadataReferences(Solution solution)
    {
        var fsharpStubs = solution
            .Projects.Where(project =>
                project.FilePath is not null
                && project.FilePath.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)
            )
            .ToDictionary(
                project => NormalizedPath(project.FilePath!),
                project => project.Id
            );

        foreach (var projectId in solution.ProjectIds.ToList())
        {
            var project = solution.GetProject(projectId);
            if (project?.FilePath?.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase) != true)
            {
                continue;
            }

            foreach (var referenced in ProjectReferences.ReadReferencedProjects(project.FilePath))
            {
                if (!referenced.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                solution = ReplaceCrossLanguageReference(
                    solution,
                    projectId,
                    referenced,
                    fsharpStubs
                );
                project = solution.GetProject(projectId)!;
            }
        }

        // Drop the now-unreferenced empty F# stub projects.
        foreach (var stubId in fsharpStubs.Values)
        {
            if (solution.GetProject(stubId) is not null)
            {
                solution = solution.RemoveProject(stubId);
            }
        }

        return solution;
    }

    /// <summary>
    /// Swap a single C# project's reference to an F# project for a metadata
    /// reference to that project's built DLL.
    /// </summary>
    private static Solution ReplaceCrossLanguageReference(
        Solution solution,
        ProjectId projectId,
        string referencedFsproj,
        Dictionary<string, ProjectId> fsharpStubs
    )
    {
        var dll = ProjectReferences.FindOutputAssembly(referencedFsproj);
        if (dll is null)
        {
            return solution;
        }

        var project = solution.GetProject(projectId)!;

        // Remove the empty project-to-project reference to the F# stub, if any.
        if (fsharpStubs.TryGetValue(NormalizedPath(referencedFsproj), out var stubId))
        {
            var stubRef = project.ProjectReferences.FirstOrDefault(reference =>
                reference.ProjectId == stubId
            );
            if (stubRef is not null)
            {
                solution = solution.RemoveProjectReference(projectId, stubRef);
                project = solution.GetProject(projectId)!;
            }
        }

        // Add the referenced project's output DLL *and its sibling assemblies*.
        // An F# assembly carries a hard dependency on FSharp.Core (and possibly
        // other packages) that sits alongside it in the output directory; without
        // those, Roslyn cannot fully load the F# type and the referenced symbol
        // stays unresolved. Dedup by simple name so framework assemblies already
        // in the compilation are never doubled.
        var outputDir = Path.GetDirectoryName(dll);
        if (outputDir is null)
        {
            return solution;
        }

        foreach (var sibling in Directory.EnumerateFiles(outputDir, "*.dll"))
        {
            if (!AlreadyReferencesSimpleName(solution.GetProject(projectId)!, sibling))
            {
                solution = solution.AddMetadataReference(
                    projectId,
                    MetadataReference.CreateFromFile(sibling)
                );
            }
        }

        Log.Debug(
            "[CrossLang] Wired {Dll} (+ siblings from {Dir}) into project {Project}",
            Path.GetFileName(dll),
            outputDir,
            project.Name
        );
        return solution;
    }

    /// <summary>Whether the project already references an assembly with the same simple name.</summary>
    private static bool AlreadyReferencesSimpleName(Project project, string dll)
    {
        var simpleName = Path.GetFileNameWithoutExtension(dll);
        return project
            .MetadataReferences.OfType<PortableExecutableReference>()
            .Any(reference =>
                string.Equals(
                    Path.GetFileNameWithoutExtension(reference.FilePath),
                    simpleName,
                    StringComparison.OrdinalIgnoreCase
                )
            );
    }

    private static string NormalizedPath(string path)
    {
        return SharpLsp.Sidecar.Common.NativePaths.NormalizeFullPath(path);
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

            var (text, position, symbol) = await FindSymbolAtLineCharacterAsync(
                    document,
                    line,
                    character,
                    ct
                )
                .ConfigureAwait(false);

            if (symbol is null or INamespaceSymbol)
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

            var (_, _, symbol) = await FindSymbolAtLineCharacterAsync(document, line, character, ct)
                .ConfigureAwait(false);

            if (symbol is null)
            {
                return new RenameEditResult.Ok<WorkspaceEditResult, string>(
                    new WorkspaceEditResult()
                );
            }

            var renamedSolution = await Microsoft
                .CodeAnalysis.Rename.Renamer.RenameSymbolAsync(
                    _solution,
                    symbol,
                    new Microsoft.CodeAnalysis.Rename.SymbolRenameOptions(),
                    newName,
                    ct
                )
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
                    var newText = SourceText.From(rawNewText.ToString(), oldText.Encoding);
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

    /// <summary>
    /// Fetch the document's source text and the symbol at the given
    /// (<paramref name="line"/>, <paramref name="character"/>) position. Returns the
    /// text so callers needing it for further work avoid a second fetch. Collapses
    /// the identical preamble shared by the prepare-rename and rename flows.
    /// </summary>
    private static async Task<(
        SourceText Text,
        int Position,
        ISymbol? Symbol
    )> FindSymbolAtLineCharacterAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines[line].Start + character;
        var symbol = await Microsoft
            .CodeAnalysis.FindSymbols.SymbolFinder.FindSymbolAtPositionAsync(document, position, ct)
            .ConfigureAwait(false);
        return (text, position, symbol);
    }
}
