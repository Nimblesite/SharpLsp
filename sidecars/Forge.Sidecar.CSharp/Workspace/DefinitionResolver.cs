using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace Forge.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves symbol locations for go-to-definition, type definition,
/// declaration, and implementation requests via Roslyn.
/// </summary>
internal static class DefinitionResolver
{
    /// <summary>Find the definition location(s) of the symbol at a position.</summary>
    public static async Task<LocationResult?> ResolveDefinitionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct)
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct)
            .ConfigureAwait(false);
        return symbol is null ? null : ToFirstSourceLocation(symbol);
    }

    /// <summary>Find the type definition of the symbol at a position.</summary>
    public static async Task<LocationResult?> ResolveTypeDefinitionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct)
    {
        var model = await document.GetSemanticModelAsync(ct)
            .ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = await ToAbsolutePositionAsync(document, line, character, ct)
            .ConfigureAwait(false);

        var typeInfo = model.GetTypeInfo(
            await GetNodeAtPositionAsync(document, position, ct)
                .ConfigureAwait(false),
            ct);

        var typeSymbol = typeInfo.Type ?? typeInfo.ConvertedType;
        return typeSymbol is null ? null : ToFirstSourceLocation(typeSymbol);
    }

    /// <summary>Find the declaration (interface/base member) of the symbol.</summary>
    public static async Task<LocationResult?> ResolveDeclarationAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct)
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return null;
        }

        var declSymbol = FindDeclarationSymbol(symbol);
        return ToFirstSourceLocation(declSymbol);
    }

    /// <summary>Find all implementations of the symbol at a position.</summary>
    public static async Task<LocationListResult> ResolveImplementationsAsync(
        Document document,
        Solution solution,
        int line,
        int character,
        CancellationToken ct)
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return new LocationListResult();
        }

        var locations = new List<LocationResult>();

        // FindImplementationsAsync handles interfaces and abstract members.
        var implementations = await SymbolFinder
            .FindImplementationsAsync(symbol, solution, cancellationToken: ct)
            .ConfigureAwait(false);
        foreach (var impl in implementations)
        {
            AddSourceLocation(locations, impl);
        }

        // For virtual/abstract methods/properties, find overrides via
        // derived classes (FindOverridesAsync is unreliable with
        // MSBuildWorkspace).
        if (symbol is IMethodSymbol or IPropertySymbol
            && (symbol.IsVirtual || symbol.IsAbstract || symbol.IsOverride))
        {
            await FindOverridesViaDerivedTypesAsync(
                symbol, solution, locations, ct).ConfigureAwait(false);
        }

        return new LocationListResult { Locations = locations };
    }

    /// <summary>Resolve the symbol at a given document position.</summary>
    private static async Task<ISymbol?> ResolveSymbolAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct)
    {
        var model = await document.GetSemanticModelAsync(ct)
            .ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = await ToAbsolutePositionAsync(
            document, line, character, ct).ConfigureAwait(false);

        var root = await document.GetSyntaxRootAsync(ct)
            .ConfigureAwait(false);
        if (root is null)
        {
            return null;
        }

        var token = root.FindToken(position);
        if (token.Parent is null)
        {
            await Console.Error.WriteLineAsync("[Resolve] token.Parent is null")
                .ConfigureAwait(false);
            return null;
        }

        // Try reference resolution first (call sites, type references).
        var symbolInfo = model.GetSymbolInfo(token.Parent, ct);
        var symbol = symbolInfo.Symbol
            ?? symbolInfo.CandidateSymbols.FirstOrDefault();
        if (symbol is not null)
        {
            return symbol;
        }

        // Fall back to declaration resolution (cursor on a declaration).
        // Walk up the syntax tree — the identifier may be nested inside
        // a declaration node (e.g., MethodDeclaration, PropertyDeclaration).
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

    /// <summary>Convert line/character to an absolute position.</summary>
    private static async Task<int> ToAbsolutePositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct)
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        return text.Lines.GetPosition(new LinePosition(line, character));
    }

    /// <summary>Get the syntax node at an absolute position.</summary>
    private static async Task<SyntaxNode> GetNodeAtPositionAsync(
        Document document,
        int position,
        CancellationToken ct)
    {
        var root = await document.GetSyntaxRootAsync(ct)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Syntax root is null");

        var token = root.FindToken(position);
        return token.Parent
            ?? throw new InvalidOperationException("Token parent is null");
    }

    /// <summary>
    /// Walk from a symbol to its declaration: base virtual/abstract member
    /// or interface member.
    /// </summary>
    private static ISymbol FindDeclarationSymbol(ISymbol symbol)
    {
        // Override → base virtual/abstract member.
        if (symbol is IMethodSymbol { OverriddenMethod: { } baseMethod })
        {
            return baseMethod;
        }

        if (symbol is IPropertySymbol { OverriddenProperty: { } baseProp })
        {
            return baseProp;
        }

        if (symbol is IEventSymbol { OverriddenEvent: { } baseEvent })
        {
            return baseEvent;
        }

        // Interface implementation → interface member.
        var interfaceMember = FindInterfaceMember(symbol);
        if (interfaceMember is not null)
        {
            return interfaceMember;
        }

        // Partial method → defining part.
        if (symbol is IMethodSymbol
            { PartialDefinitionPart: { } defPart })
        {
            return defPart;
        }

        // No declaration to navigate to — return the symbol itself.
        return symbol;
    }

    /// <summary>
    /// Find the interface member that a symbol implements.
    /// </summary>
    private static ISymbol? FindInterfaceMember(ISymbol symbol)
    {
        var containingType = symbol.ContainingType;
        if (containingType is null)
        {
            return null;
        }

        foreach (var iface in containingType.AllInterfaces)
        {
            foreach (var member in iface.GetMembers())
            {
                var impl = containingType.FindImplementationForInterfaceMember(
                    member);
                if (SymbolEqualityComparer.Default.Equals(impl, symbol))
                {
                    return member;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Find overrides of a virtual/abstract member by walking derived types.
    /// This is more reliable than FindOverridesAsync with MSBuildWorkspace.
    /// </summary>
    private static async Task FindOverridesViaDerivedTypesAsync(
        ISymbol symbol,
        Solution solution,
        List<LocationResult> locations,
        CancellationToken ct)
    {
        var containingType = symbol.ContainingType;
        if (containingType is null)
        {
            return;
        }

        await Console.Error.WriteLineAsync(
            $"[Override] Looking for overrides of {containingType.Name}.{symbol.Name}")
            .ConfigureAwait(false);

        var derivedTypes = await SymbolFinder
            .FindDerivedClassesAsync(containingType, solution, cancellationToken: ct)
            .ConfigureAwait(false);

        await Console.Error.WriteLineAsync(
            $"[Override] Found {derivedTypes.Count()} derived types")
            .ConfigureAwait(false);

        foreach (var derived in derivedTypes)
        {
            await Console.Error.WriteLineAsync(
                $"[Override] Checking {derived.Name}")
                .ConfigureAwait(false);
            foreach (var member in derived.GetMembers(symbol.Name))
            {
                await Console.Error.WriteLineAsync(
                    $"[Override] Member {member.Name} override={member.IsOverride}")
                    .ConfigureAwait(false);
                if (member.IsOverride)
                {
                    AddSourceLocation(locations, member);
                }
            }
        }
    }

    /// <summary>Add a symbol's source location to a list if in source.</summary>
    private static void AddSourceLocation(List<LocationResult> locations, ISymbol symbol)
    {
        var loc = ToFirstSourceLocation(symbol);
        if (loc is not null)
        {
            locations.Add(loc);
        }
    }

    /// <summary>Map a symbol to its first in-source location.</summary>
    private static LocationResult? ToFirstSourceLocation(ISymbol symbol)
    {
        var location = symbol.Locations
            .FirstOrDefault(l => l.IsInSource);
        if (location is null)
        {
            return null;
        }

        var span = location.GetMappedLineSpan();
        return new LocationResult
        {
            FilePath = span.Path,
            Line = span.StartLinePosition.Line,
            Character = span.StartLinePosition.Character,
        };
    }
}
