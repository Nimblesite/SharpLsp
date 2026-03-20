using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Completion;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Manages the Roslyn MSBuildWorkspace lifecycle.
/// Provides semantic operations: diagnostics, completions, hover, go-to-definition.
/// </summary>
public sealed class WorkspaceManager
{
    private MSBuildWorkspace? _workspace;
    private Solution? _solution;

    public bool IsLoaded => _solution is not null;

    /// <summary>Open a solution or project file via MSBuildWorkspace.</summary>
    public async Task OpenAsync(string path, CancellationToken ct = default)
    {
        var properties = new Dictionary<string, string>
        {
            ["DesignTimeBuild"] = "true",
            ["BuildingInsideVisualStudio"] = "true",
            ["SkipCompilerExecution"] = "true",
        };

        _workspace = MSBuildWorkspace.Create(properties);
        _workspace.WorkspaceFailed += (_, args) =>
            Console.Error.WriteLine($"Workspace warning: {args.Diagnostic.Message}");

        var target = SolutionLoader.FindSolutionOrProject(path);
        if (target is null)
        {
            throw new FileNotFoundException(
                $"No .sln or .csproj found at or under '{path}'.");
        }

        if (target.EndsWith(".sln", StringComparison.OrdinalIgnoreCase))
        {
            _solution = await _workspace.OpenSolutionAsync(target, cancellationToken: ct)
                .ConfigureAwait(false);
        }
        else
        {
            var project = await _workspace.OpenProjectAsync(target, cancellationToken: ct)
                .ConfigureAwait(false);
            _solution = project.Solution;
        }

        Console.Error.WriteLine(
            $"Loaded {_solution.ProjectIds.Count} project(s) from {target}");
    }

    /// <summary>Get compiler diagnostics for a file.</summary>
    public async Task<List<DiagnosticResult>> GetDiagnosticsAsync(
        string filePath,
        CancellationToken ct = default)
    {
        var (document, _) = FindDocument(filePath);
        if (document is null)
        {
            return [];
        }

        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (semanticModel is null)
        {
            return [];
        }

        var results = new List<DiagnosticResult>();
        foreach (var diag in semanticModel.GetDiagnostics(cancellationToken: ct))
        {
            var span = diag.Location.GetMappedLineSpan();
            if (!span.IsValid)
            {
                continue;
            }

            results.Add(new DiagnosticResult
            {
                FilePath = filePath,
                StartLine = span.StartLinePosition.Line,
                StartCharacter = span.StartLinePosition.Character,
                EndLine = span.EndLinePosition.Line,
                EndCharacter = span.EndLinePosition.Character,
                Message = diag.GetMessage(),
                Severity = diag.Severity.ToString(),
                Code = diag.Id,
            });
        }

        return results;
    }

    /// <summary>Get completion items at a position.</summary>
    public async Task<List<CompletionItem>> GetCompletionsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default)
    {
        var (document, _) = FindDocument(filePath);
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

        var completions = await service.GetCompletionsAsync(document, position, cancellationToken: ct)
            .ConfigureAwait(false);
        if (completions is null)
        {
            return [];
        }

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

    /// <summary>Get hover information at a position.</summary>
    public async Task<HoverResult?> GetHoverAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default)
    {
        var (document, _) = FindDocument(filePath);
        if (document is null)
        {
            return null;
        }

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(line, character));

        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (semanticModel is null)
        {
            return null;
        }

        var symbolInfo = semanticModel.GetSymbolInfo(
            (await document.GetSyntaxRootAsync(ct).ConfigureAwait(false))!
                .FindToken(position).Parent!,
            ct);

        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();
        if (symbol is null)
        {
            return null;
        }

        return new HoverResult
        {
            Contents = symbol.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat),
        };
    }

    /// <summary>Go to definition at a position.</summary>
    public async Task<LocationResult?> GetDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default)
    {
        var (document, _) = FindDocument(filePath);
        if (document is null)
        {
            return null;
        }

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(line, character));

        var semanticModel = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (semanticModel is null)
        {
            return null;
        }

        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var token = root!.FindToken(position);
        var symbolInfo = semanticModel.GetSymbolInfo(token.Parent!, ct);
        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();

        if (symbol is null)
        {
            return null;
        }

        var location = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (location is null)
        {
            return null;
        }

        var defSpan = location.GetMappedLineSpan();
        return new LocationResult
        {
            FilePath = defSpan.Path,
            Line = defSpan.StartLinePosition.Line,
            Character = defSpan.StartLinePosition.Character,
        };
    }

    private (Document? Document, SourceText? Text) FindDocument(string filePath)
    {
        if (_solution is null)
        {
            return (null, null);
        }

        var normalizedPath = Path.GetFullPath(filePath);
        foreach (var project in _solution.Projects)
        {
            foreach (var document in project.Documents)
            {
                if (document.FilePath is not null &&
                    string.Equals(
                        Path.GetFullPath(document.FilePath),
                        normalizedPath,
                        StringComparison.OrdinalIgnoreCase))
                {
                    return (document, null);
                }
            }
        }

        return (null, null);
    }
}
