using Microsoft.CodeAnalysis;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves type hierarchy (supertypes/subtypes) via Roslyn.
/// </summary>
internal static class TypeHierarchyResolver
{
    /// <summary>Prepare a type hierarchy item at the given position.</summary>
    public static async Task<HierarchyItem?> PrepareAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveTypeAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        return symbol is null ? null : ToItem(symbol);
    }

    /// <summary>Get supertypes (base class + interfaces).</summary>
    public static Task<List<HierarchyItem>> GetSupertypesAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.CollectAsync<INamedTypeSymbol, HierarchyItem>(
            ResolveTypeAtPositionAsync(document, line, character, ct),
            (symbol, results) =>
            {
                AddItems(Supertypes(symbol), results);
                return Task.CompletedTask;
            }
        );
    }

    /// <summary>Get subtypes (derived classes + implementors) from each project's active framework.</summary>
    public static Task<List<HierarchyItem>> GetSubtypesAsync(
        Document document,
        SearchScope scope,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.CollectAsync<INamedTypeSymbol, HierarchyItem>(
            ResolveTypeAtPositionAsync(document, line, character, ct),
            async (symbol, results) =>
            {
                AddItems(
                    await scope.FindDerivedClassesAsync(symbol, ct).ConfigureAwait(false),
                    results
                );
                if (symbol.TypeKind == TypeKind.Interface)
                {
                    var impls = await scope
                        .FindImplementationsAsync(symbol, ct)
                        .ConfigureAwait(false);
                    AddItems(impls.OfType<INamedTypeSymbol>(), results);
                }
            }
        );
    }

    /// <summary>The base class, unless it is <c>object</c>, then every interface.</summary>
    private static IEnumerable<INamedTypeSymbol> Supertypes(INamedTypeSymbol symbol)
    {
        return symbol.BaseType is { SpecialType: not SpecialType.System_Object } baseType
            ? symbol.Interfaces.Prepend(baseType)
            : symbol.Interfaces;
    }

    /// <summary>The item of each type declared in source, in order.</summary>
    private static void AddItems(IEnumerable<INamedTypeSymbol> types, List<HierarchyItem> results)
    {
        results.AddRange(types.Select(ToItem).OfType<HierarchyItem>());
    }

    private static Task<INamedTypeSymbol?> ResolveTypeAtPositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return DocumentPosition.ResolveSymbolAsync(
            document,
            (line, character),
            ResolveNamedType,
            ct
        );
    }

    private static INamedTypeSymbol? ResolveNamedType(
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
        if (info.Symbol is INamedTypeSymbol nt)
        {
            return nt;
        }

        var node = token.Parent;
        while (node is not null)
        {
            if (model.GetDeclaredSymbol(node, ct) is INamedTypeSymbol declared)
            {
                return declared;
            }

            node = node.Parent;
        }

        return null;
    }

    private static HierarchyItem? ToItem(INamedTypeSymbol symbol)
    {
        return DocumentPosition.ToHierarchyItem<HierarchyItem>(symbol, MapKind(symbol));
    }

    private static string MapKind(INamedTypeSymbol symbol)
    {
        return symbol.TypeKind == TypeKind.Interface ? "interface"
            : symbol.TypeKind == TypeKind.Struct ? "struct"
            : symbol.TypeKind == TypeKind.Enum ? "enum"
            : symbol.TypeKind == TypeKind.Delegate ? "delegate"
            : "class";
    }
}
