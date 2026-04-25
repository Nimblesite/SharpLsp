using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves type hierarchy (supertypes/subtypes) via Roslyn.
/// </summary>
internal static class TypeHierarchyResolver
{
    /// <summary>Prepare a type hierarchy item at the given position.</summary>
    public static async Task<TypeHierarchyItem?> PrepareAsync(
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
    public static async Task<List<TypeHierarchyItem>> GetSupertypesAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveTypeAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        var results = new List<TypeHierarchyItem>();
        if (symbol.BaseType is not null && symbol.BaseType.SpecialType != SpecialType.System_Object)
        {
            var item = ToItem(symbol.BaseType);
            if (item is not null)
            {
                results.Add(item);
            }
        }

        foreach (var iface in symbol.Interfaces)
        {
            var item = ToItem(iface);
            if (item is not null)
            {
                results.Add(item);
            }
        }

        return results;
    }

    /// <summary>Get subtypes (derived classes + implementors).</summary>
    public static async Task<List<TypeHierarchyItem>> GetSubtypesAsync(
        Document document,
        Solution solution,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveTypeAtPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        var results = new List<TypeHierarchyItem>();
        var derived = await SymbolFinder
            .FindDerivedClassesAsync(symbol, solution, cancellationToken: ct)
            .ConfigureAwait(false);
        foreach (var d in derived)
        {
            var item = ToItem(d);
            if (item is not null)
            {
                results.Add(item);
            }
        }

        if (symbol.TypeKind == TypeKind.Interface)
        {
            var impls = await SymbolFinder
                .FindImplementationsAsync(symbol, solution, cancellationToken: ct)
                .ConfigureAwait(false);
            foreach (var impl in impls.OfType<INamedTypeSymbol>())
            {
                var item = ToItem(impl);
                if (item is not null)
                {
                    results.Add(item);
                }
            }
        }

        return results;
    }

    private static async Task<INamedTypeSymbol?> ResolveTypeAtPositionAsync(
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
        return ResolveNamedType(token, model, ct);
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

    private static TypeHierarchyItem? ToItem(INamedTypeSymbol symbol)
    {
        var loc = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        if (loc is null)
        {
            return null;
        }

        var span = loc.GetMappedLineSpan();
        return new TypeHierarchyItem
        {
            Name = symbol.Name,
            Kind = MapKind(symbol),
            FilePath = span.Path,
            Line = span.StartLinePosition.Line,
            Character = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
        };
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
