using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves call hierarchy (incoming/outgoing calls) via Roslyn.
/// </summary>
internal static class CallHierarchyResolver
{
    /// <summary>Prepare a call hierarchy item at the given position.</summary>
    public static async Task<HierarchyItem?> PrepareAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        return symbol is null ? null : ToCallHierarchyItem(symbol);
    }

    /// <summary>Get incoming calls for a symbol, from each project's active framework.</summary>
    public static Task<List<CallHierarchyCallResult>> GetIncomingAsync(
        Document document,
        SearchScope scope,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.CollectAsync<ISymbol, CallHierarchyCallResult>(
            ResolveAtPositionAsync(document, line, character, ct),
            async (symbol, results) =>
            {
                var callers = await scope.FindCallersAsync(symbol, ct).ConfigureAwait(false);
                foreach (var caller in callers)
                {
                    AddCall(caller.CallingSymbol, caller.Locations, results);
                }
            }
        );
    }

    /// <summary>Get outgoing calls from a symbol.</summary>
    public static Task<List<CallHierarchyCallResult>> GetOutgoingAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.CollectAsync<ISymbol, CallHierarchyCallResult>(
            ResolveAtPositionAsync(document, line, character, ct),
            (symbol, results) => CollectOutgoingAsync(document, symbol, results, ct)
        );
    }

    /// <summary>The calls made in each in-source declaration of <paramref name="symbol"/>.</summary>
    private static async Task CollectOutgoingAsync(
        Document document,
        ISymbol symbol,
        List<CallHierarchyCallResult> results,
        CancellationToken ct
    )
    {
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
                AddCall(symbolInfo.Symbol, [invocation.GetLocation()], results);
            }
        }
    }

    private static Task<ISymbol?> ResolveAtPositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.ResolveSymbolAsync(document, (line, character), ResolveSymbol, ct);
    }

    private static ISymbol? ResolveSymbol(
        SyntaxToken token,
        SemanticModel model,
        CancellationToken ct
    )
    {
        return token.Parent is not { } parent
            ? null
            : model.GetSymbolInfo(parent, ct).Symbol
                ?? DocumentPosition.EnclosingDeclaredSymbol(parent, model, ct);
    }

    private static HierarchyItem? ToCallHierarchyItem(ISymbol symbol)
    {
        return DocumentPosition.ToHierarchyItem<HierarchyItem>(symbol, MapSymbolKind(symbol));
    }

    /// <summary>
    /// Record call sites against the symbol they belong to, merging repeats.
    /// </summary>
    /// <remarks>
    /// LSP wants ONE entry per symbol carrying every range it is called at, each once; a
    /// second entry for the same method renders as a duplicate row in the tree that expands
    /// to exactly the same children. A property read is found again through its getter.
    /// </remarks>
    private static void AddCall(
        ISymbol symbol,
        IEnumerable<Location> sites,
        List<CallHierarchyCallResult> results
    )
    {
        var result = ToCallResult(symbol, sites);
        if (result is null)
        {
            return;
        }

        var existing = results.Find(r =>
            r.Name == result.Name && r.FilePath == result.FilePath && r.Line == result.Line
        );
        if (existing is null)
        {
            results.Add(result);
            return;
        }

        existing.FromRanges.AddRange(
            result.FromRanges.Where(site =>
                !existing.FromRanges.Exists(known => SameSite(known, site))
            )
        );
    }

    private static bool SameSite(CallSiteResult left, CallSiteResult right)
    {
        return (left.Line, left.Character, left.EndLine, left.EndCharacter)
            == (right.Line, right.Character, right.EndLine, right.EndCharacter);
    }

    private static CallHierarchyCallResult? ToCallResult(
        ISymbol symbol,
        IEnumerable<Location> callSites
    )
    {
        var result = DocumentPosition.ToHierarchyItem<CallHierarchyCallResult>(
            symbol,
            MapSymbolKind(symbol)
        );
        result?.FromRanges.AddRange(callSites.Where(l => l.IsInSource).Select(ToCallSite));
        return result;
    }

    /// <summary>One source location as the range the host publishes.</summary>
    private static CallSiteResult ToCallSite(Location location)
    {
        var (_, line, character, endLine, endCharacter) = DocumentPosition.Coordinates(
            location.GetMappedLineSpan()
        );
        return new CallSiteResult
        {
            Line = line,
            Character = character,
            EndLine = endLine,
            EndCharacter = endCharacter,
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
}
