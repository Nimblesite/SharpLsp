using Forge.Sidecar.CSharp.Hover;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Outcome;

using VoidResult = Outcome.Result<Outcome.Unit, string>;
using AllDiagnosticsResult = Outcome.Result<System.Collections.Generic.Dictionary<string, System.Collections.Generic.List<Forge.Sidecar.CSharp.DiagnosticResult>>, string>;
using DiagnosticsResult = Outcome.Result<System.Collections.Generic.List<Forge.Sidecar.CSharp.DiagnosticResult>, string>;
using CompletionsResult = Outcome.Result<System.Collections.Generic.List<Forge.Sidecar.CSharp.CompletionItem>, string>;
using HoverQueryResult = Outcome.Result<Forge.Sidecar.CSharp.HoverResult?, string>;
using DefinitionResult = Outcome.Result<Forge.Sidecar.CSharp.LocationResult?, string>;
using ImplementationsResult = Outcome.Result<Forge.Sidecar.CSharp.LocationListResult, string>;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Manages the Roslyn MSBuildWorkspace lifecycle.
/// Provides semantic operations: diagnostics, completions, hover, go-to-definition.
/// </summary>
internal sealed class WorkspaceManager
{
    private MSBuildWorkspace? _workspace;
    private Solution? _solution;

    public bool IsLoaded => _solution is not null;

    /// <summary>Open a solution or project file via MSBuildWorkspace.</summary>
    [Obsolete("Placeholder until workspace loading is redesigned")]
    public async Task<VoidResult> OpenAsync(
        string path,
        CancellationToken ct = default)
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
        CancellationToken ct = default)
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct)
                .ConfigureAwait(false);
            if (document is null)
            {
                return VoidResult.Failure(
                    $"Document not found: {filePath}");
            }

            var newSource = SourceText.From(newText);
            _solution = _solution!.WithDocumentText(
                document.Id, newSource);
            return new VoidResult.Ok<Unit, string>(Unit.Value);
        }
        catch (Exception ex)
        {
            return VoidResult.Failure(ex.Message);
        }
    }

    /// <summary>Get compiler diagnostics for a file.</summary>
    public async Task<DiagnosticsResult>
        GetDiagnosticsAsync(
            string filePath,
            CancellationToken ct = default)
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct)
                .ConfigureAwait(false);
            if (document is null)
            {
                return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>([]);
            }

            var model = await document.GetSemanticModelAsync(ct)
                .ConfigureAwait(false);
            return model is null
                ? new DiagnosticsResult.Ok<List<DiagnosticResult>, string>([])
                : new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(
                    MapDiagnostics(filePath, model, ct));
        }
        catch (Exception ex)
        {
            return DiagnosticsResult.Failure(ex.Message);
        }
    }

    /// <summary>Get compiler diagnostics for all files in the solution.</summary>
    public async Task<AllDiagnosticsResult>
        GetAllDiagnosticsAsync(
            string[] projectFilter,
            CancellationToken ct = default)
    {
        try
        {
            if (_solution is null)
            {
                return new AllDiagnosticsResult
                    .Ok<Dictionary<string, List<DiagnosticResult>>, string>(
                        new Dictionary<string, List<DiagnosticResult>>());
            }

            var results = new Dictionary<string, List<DiagnosticResult>>();
            var projects = FilterProjects(projectFilter);

            foreach (var project in projects)
            {
                ct.ThrowIfCancellationRequested();
                await CollectProjectDiagnosticsAsync(
                    project, results, ct).ConfigureAwait(false);
            }

            return new AllDiagnosticsResult
                .Ok<Dictionary<string, List<DiagnosticResult>>, string>(
                    results);
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

    /// <summary>Get completion items at a position.</summary>
    public async Task<CompletionsResult>
        GetCompletionsAsync(
            string filePath,
            int line,
            int character,
            CancellationToken ct = default)
    {
        try
        {
            var items = await GetCompletionsCoreAsync(
                filePath, line, character, ct).ConfigureAwait(false);
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
        CancellationToken ct = default)
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct)
                .ConfigureAwait(false);
            if (document is null)
            {
                return new HoverQueryResult.Ok<HoverResult?, string>(null);
            }

            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var position = text.Lines.GetPosition(
                new LinePosition(line, character));
            var model = await document.GetSemanticModelAsync(ct)
                .ConfigureAwait(false);
            return model is null
                ? new HoverQueryResult.Ok<HoverResult?, string>(null)
                : CSharpHoverBuilder.Build(model, position, ct);
        }
        catch (Exception ex)
        {
            return HoverQueryResult.Failure(ex.Message);
        }
    }

    /// <summary>Go to definition at a position (returns all locations for partial types).</summary>
    public async Task<ImplementationsResult> GetDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default)
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct)
                .ConfigureAwait(false);
            if (document is null)
            {
                return new ImplementationsResult.Ok<LocationListResult, string>(
                    new LocationListResult());
            }

            var result = await DefinitionResolver
                .ResolveDefinitionLocationsAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new ImplementationsResult.Ok<LocationListResult, string>(
                result);
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
        CancellationToken ct = default)
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct)
                .ConfigureAwait(false);
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
        CancellationToken ct = default)
    {
        try
        {
            var document = FindDocument(filePath);
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
        CancellationToken ct = default)
    {
        try
        {
            var document = FindDocument(filePath);
            if (document is null || _solution is null)
            {
                return new ImplementationsResult.Ok<LocationListResult, string>(
                    new LocationListResult());
            }

            var result = await DefinitionResolver
                .ResolveImplementationsAsync(
                    document, _solution, line, character, ct)
                .ConfigureAwait(false);
            return new ImplementationsResult.Ok<LocationListResult, string>(
                result);
        }
        catch (Exception ex)
        {
            return ImplementationsResult.Failure(ex.Message);
        }
    }

    private async Task<VoidResult> OpenCoreAsync(
        string path,
        CancellationToken ct)
    {
        var properties = new Dictionary<string, string>
        {
            ["DesignTimeBuild"] = "true",
            ["BuildingInsideVisualStudio"] = "true",
            ["SkipCompilerExecution"] = "true",
        };

        _workspace = MSBuildWorkspace.Create(properties);
        _ = _workspace.RegisterWorkspaceFailedHandler(args =>
            Console.Error.WriteLine(
                $"Workspace warning: {args.Diagnostic.Message}"));

        var findResult = SolutionLoader.FindSolutionOrProject(path);
        if (findResult.IsError)
        {
            return VoidResult.Failure(
                !findResult ?? "Search failed");
        }

        var target = findResult.Match(
                value => value,
                _ => null)
            ?? throw new FileNotFoundException(
                $"No .sln or .csproj found at or under '{path}'.");

        _solution = await LoadSolutionOrProjectAsync(target, ct)
            .ConfigureAwait(false);

        await Console.Error.WriteLineAsync(
            $"Loaded {_solution.ProjectIds.Count} project(s) from {target}")
            .ConfigureAwait(false);

        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    private async Task<Solution> LoadSolutionOrProjectAsync(
        string target,
        CancellationToken ct)
    {
        if (target.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
        {
            return await _workspace!.OpenSolutionAsync(
                target, cancellationToken: ct).ConfigureAwait(false);
        }

        var project = await _workspace!.OpenProjectAsync(
            target, cancellationToken: ct).ConfigureAwait(false);
        return project.Solution;
    }

    private static List<DiagnosticResult> MapDiagnostics(
        string filePath,
        SemanticModel model,
        CancellationToken ct)
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
        FileLinePositionSpan span)
    {
        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = span.StartLinePosition.Line,
            StartCharacter = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
            Message = diag.GetMessage(
                System.Globalization.CultureInfo.InvariantCulture),
            Severity = diag.Severity.ToString(),
            Code = diag.Id,
        };
    }

    private async Task<List<CompletionItem>> GetCompletionsCoreAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct)
    {
        var document = FindDocument(filePath);
        if (document is null)
        {
            return [];
        }

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(
            new LinePosition(line, character));

        var service = CompletionService.GetService(document);
        if (service is null)
        {
            return [];
        }

        var completions = await service.GetCompletionsAsync(
            document, position, cancellationToken: ct).ConfigureAwait(false);
        return completions is null ? [] : MapCompletionItems(completions);
    }

    private static List<CompletionItem> MapCompletionItems(
        CompletionList completions)
    {
        var results = new List<CompletionItem>();
        foreach (var item in completions.ItemsList)
        {
            results.Add(new CompletionItem
            {
                Label = item.DisplayText,
                Kind = item.Tags.Length > 0 ? item.Tags[0] : "Text",
                Detail = item.InlineDescription,
                InsertText = item.FilterText,
            });
        }

        return results;
    }

    private IEnumerable<Project> FilterProjects(string[] filter)
    {
        return filter.Length == 0
            ? _solution!.Projects
            : _solution!.Projects.Where(
                project => filter.Any(
                    pattern => project.Name.Contains(
                        pattern, StringComparison.OrdinalIgnoreCase)));
    }

    private static async Task CollectProjectDiagnosticsAsync(
        Project project,
        Dictionary<string, List<DiagnosticResult>> results,
        CancellationToken ct)
    {
        var compilation = await project.GetCompilationAsync(ct)
            .ConfigureAwait(false);
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

    private Document? FindDocument(string filePath)
    {
        if (_solution is null)
        {
            return null;
        }

        try
        {
            var normalizedPath = Path.GetFullPath(filePath);
            return FindDocumentByPath(normalizedPath);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private Document? FindDocumentByPath(string normalizedPath)
    {
        foreach (var project in _solution!.Projects)
        {
            foreach (var document in project.Documents)
            {
                if (document.FilePath is null)
                {
                    continue;
                }

                if (string.Equals(
                        Path.GetFullPath(document.FilePath),
                        normalizedPath,
                        StringComparison.OrdinalIgnoreCase))
                {
                    return document;
                }
            }
        }

        return null;
    }
}
