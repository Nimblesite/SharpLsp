using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves call hierarchy (incoming/outgoing calls) via Roslyn.
/// </summary>
internal static class CallHierarchyResolver
{
    /// <summary>Prepare a call hierarchy item at the given position.</summary>
    public static async Task<CallHierarchyItem?> PrepareAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = text.Lines.GetPosition(new LinePosition(line, character));
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root is null)
        {
            return null;
        }

        var token = root.FindToken(position);
        var symbol = ResolveSymbol(token, model, ct);
        return symbol is null ? null : ToCallHierarchyItem(symbol);
    }

    /// <summary>Get incoming calls for a symbol.</summary>
    public static async Task<List<CallHierarchyCallResult>> GetIncomingAsync(
        Solution solution,
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var document = FindDocument(solution, filePath);
        if (document is null)
        {
            return [];
        }

        var symbol = await ResolveAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        var callers = await SymbolFinder
            .FindCallersAsync(symbol, solution, cancellationToken: ct)
            .ConfigureAwait(false);
        return
        [
            .. callers
                .Where(c => c.IsDirect)
                .Select(c => ToCallResult(c.CallingSymbol))
                .Where(c => c is not null)
                .Cast<CallHierarchyCallResult>(),
        ];
    }

    /// <summary>Get outgoing calls from a symbol.</summary>
    public static async Task<List<CallHierarchyCallResult>> GetOutgoingAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        var results = new List<CallHierarchyCallResult>();
        foreach (var location in symbol.Locations.Where(l => l.IsInSource))
        {
            var tree = location.SourceTree;
            if (tree is null)
            {
                continue;
            }

            var model = await document
                .Project.Solution.GetDocument(document.Id)!
                .GetSemanticModelAsync(ct)
                .ConfigureAwait(false);
            if (model is null)
            {
                continue;
            }

            var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
            var node = root.FindNode(location.SourceSpan);
            CollectOutgoingCalls(node, model, results, ct);
        }

        return results;
    }

    private static void CollectOutgoingCalls(
        SyntaxNode node,
        SemanticModel model,
        List<CallHierarchyCallResult> results,
        CancellationToken ct
    )
    {
        foreach (var invocation in node.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            ct.ThrowIfCancellationRequested();
            var symbolInfo = model.GetSymbolInfo(invocation, ct);
            if (symbolInfo.Symbol is not null)
            {
                var result = ToCallResult(symbolInfo.Symbol);
                if (result is not null)
                {
                    results.Add(result);
                }
            }
        }
    }

    private static async Task<ISymbol?> ResolveAtPositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = text.Lines.GetPosition(new LinePosition(line, character));
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return root is null ? null : ResolveSymbol(root.FindToken(position), model, ct);
    }

    private static ISymbol? ResolveSymbol(
        SyntaxToken token,
        SemanticModel model,
        CancellationToken ct
    )
    {
        if (token.Parent is null)
        {
            return null;
        }

        var info = model.GetSymbolInfo(token.Parent, ct);
        var symbol = info.Symbol;
        if (symbol is not null)
        {
            return symbol;
        }

        var node = token.Parent;
        while (node is not null)
        {
            var declared = model.GetDeclaredSymbol(node, ct);
            if (declared is not null)
            {
                return declared;
            }

            node = node.Parent;
        }

        return null;
    }

    private static CallHierarchyItem? ToCallHierarchyItem(ISymbol symbol)
    {
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc is null)
        {
            return null;
        }

        var span = loc.GetMappedLineSpan();
        return new CallHierarchyItem
        {
            Name = symbol.Name,
            Kind = MapSymbolKind(symbol),
            FilePath = span.Path,
            Line = span.StartLinePosition.Line,
            Character = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
        };
    }

    private static CallHierarchyCallResult? ToCallResult(ISymbol symbol)
    {
        var item = ToCallHierarchyItem(symbol);
        return item is null
            ? null
            : new CallHierarchyCallResult
            {
                Name = item.Name,
                Kind = item.Kind,
                FilePath = item.FilePath,
                Line = item.Line,
                Character = item.Character,
                EndLine = item.EndLine,
                EndCharacter = item.EndCharacter,
            };
    }

    private static string MapSymbolKind(ISymbol symbol)
    {
        return symbol.Kind switch
        {
            SymbolKind.Method => "method",
            SymbolKind.Property => "property",
            SymbolKind.Field => "field",
            SymbolKind.NamedType => "class",
            SymbolKind.Event => "event",
            SymbolKind.Namespace => "namespace",
            SymbolKind.Local => "variable",
            SymbolKind.Parameter => "parameter",
            SymbolKind.TypeParameter => "typeParameter",
            SymbolKind.ArrayType
            or SymbolKind.PointerType
            or SymbolKind.FunctionPointerType
            or SymbolKind.ErrorType
            or SymbolKind.DynamicType
            or SymbolKind.Preprocessing
            or SymbolKind.Label
            or SymbolKind.Alias
            or SymbolKind.RangeVariable
            or SymbolKind.Assembly
            or SymbolKind.NetModule
            or SymbolKind.Discard => "function",
            _ => "function",
        };
    }

    private static Document? FindDocument(Solution solution, string filePath)
    {
        var normalized = Path.GetFullPath(filePath);
        foreach (var project in solution.Projects)
        {
            foreach (var doc in project.Documents)
            {
                if (
                    doc.FilePath is not null
                    && string.Equals(
                        Path.GetFullPath(doc.FilePath),
                        normalized,
                        StringComparison.OrdinalIgnoreCase
                    )
                )
                {
                    return doc;
                }
            }
        }

        return null;
    }
}
