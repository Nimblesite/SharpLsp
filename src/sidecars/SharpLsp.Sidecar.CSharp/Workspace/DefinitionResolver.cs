using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves symbol locations for go-to-definition, type definition and
/// declaration requests via Roslyn; <see cref="ReferenceResolver"/> answers
/// the requests that search beyond the declaration.
/// </summary>
internal static class DefinitionResolver
{
    /// <summary>Find all definition locations of the symbol at a position.</summary>
    public static async Task<LocationListResult> ResolveDefinitionLocationsAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return await ResolveSymbolLocationsAsync(
                document,
                line,
                character,
                async symbol =>
                {
                    var sourceLocations = ToAllSourceLocations(symbol);
                    return sourceLocations.Locations.Count > 0
                        ? sourceLocations
                        : await ResolveMetadataFallbackAsync(document, symbol, ct)
                            .ConfigureAwait(false);
                },
                ct
            )
            .ConfigureAwait(false);
    }

    /// <summary>
    /// Resolve the symbol at a position, returning an empty
    /// <see cref="LocationListResult"/> when none is found, otherwise mapping it
    /// via <paramref name="map"/>. Collapses the identical resolve-or-empty guard
    /// shared by the definition, implementation, and reference resolvers.
    /// </summary>
    internal static async Task<LocationListResult> ResolveSymbolLocationsAsync(
        Document document,
        int line,
        int character,
        Func<ISymbol, Task<LocationListResult>> map,
        CancellationToken ct
    )
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct).ConfigureAwait(false);
        return symbol is null ? new LocationListResult() : await map(symbol).ConfigureAwait(false);
    }

    /// <summary>
    /// Fall back to decompiled metadata when no in-source locations exist.
    /// </summary>
    private static async Task<LocationListResult> ResolveMetadataFallbackAsync(
        Document document,
        ISymbol symbol,
        CancellationToken ct
    )
    {
        var compilation = await document.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation is null)
        {
            return new LocationListResult();
        }

        var metadataLocation = MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);

        return metadataLocation is null
            ? new LocationListResult()
            : new LocationListResult { Locations = [metadataLocation] };
    }

    /// <summary>
    /// Single-location metadata fallback for type-definition and declaration.
    /// </summary>
    private static async Task<LocationResult?> ResolveMetadataFallbackSingleAsync(
        Document document,
        ISymbol symbol,
        CancellationToken ct
    )
    {
        var compilation = await document.Project.GetCompilationAsync(ct).ConfigureAwait(false);

        return compilation is null
            ? null
            : MetadataNavigator.ResolveMetadataSymbol(symbol, compilation);
    }

    /// <summary>Find the type definition of the symbol at a position.</summary>
    public static async Task<LocationResult?> ResolveTypeDefinitionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var resolved = await ResolveModelAndPositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (resolved is null)
        {
            return null;
        }

        var (model, position) = resolved.Value;

        var typeInfo = model.GetTypeInfo(
            await GetNodeAtPositionAsync(document, position, ct).ConfigureAwait(false),
            ct
        );

        var typeSymbol = typeInfo.Type ?? typeInfo.ConvertedType;

        return typeSymbol is null
            ? null
            : ToFirstSourceLocation(typeSymbol)
                ?? await ResolveMetadataFallbackSingleAsync(document, typeSymbol, ct)
                    .ConfigureAwait(false);
    }

    /// <summary>Find the declaration (interface/base member) of the symbol.</summary>
    public static async Task<LocationResult?> ResolveDeclarationAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct).ConfigureAwait(false);
        if (symbol is null)
        {
            return null;
        }

        var declSymbol = FindDeclarationSymbol(symbol);
        return ToFirstSourceLocation(declSymbol)
            ?? await ResolveMetadataFallbackSingleAsync(document, declSymbol, ct)
                .ConfigureAwait(false);
    }

    /// <summary>Resolve the symbol at a given document position.</summary>
    internal static async Task<ISymbol?> ResolveSymbolAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var resolved = await DocumentPosition
            .ResolveTokenAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (resolved is not { Token.Parent: { } parent } found)
        {
            Log.Debug("[Resolve] no token with a parent at the position");
            return null;
        }

        // Reference resolution first (call sites, type references), then the
        // declaration the cursor sits in.
        var symbolInfo = found.Model.GetSymbolInfo(parent, ct);
        return symbolInfo.Symbol
            ?? symbolInfo.CandidateSymbols.FirstOrDefault()
            ?? DocumentPosition.EnclosingDeclaredSymbol(parent, found.Model, ct);
    }

    /// <summary>Convert line/character to an absolute position.</summary>
    private static async Task<int> ToAbsolutePositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        return text.Lines.GetPosition(new LinePosition(line, character));
    }

    /// <summary>
    /// Fetch the semantic model and resolve <paramref name="line"/>/<paramref name="character"/>
    /// to an absolute position. Returns <see langword="null"/> when the document exposes no
    /// semantic model. Shared preamble of the symbol- and type-definition resolvers.
    /// </summary>
    private static async Task<(SemanticModel Model, int Position)?> ResolveModelAndPositionAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = await ToAbsolutePositionAsync(document, line, character, ct)
            .ConfigureAwait(false);
        return (model, position);
    }

    /// <summary>Get the syntax node at an absolute position.</summary>
    private static async Task<SyntaxNode> GetNodeAtPositionAsync(
        Document document,
        int position,
        CancellationToken ct
    )
    {
        var root =
            await document.GetSyntaxRootAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Syntax root is null");

        var token = root.FindToken(position);
        return token.Parent ?? throw new InvalidOperationException("Token parent is null");
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
        if (symbol is IMethodSymbol { PartialDefinitionPart: { } defPart })
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
                var impl = containingType.FindImplementationForInterfaceMember(member);
                if (SymbolEqualityComparer.Default.Equals(impl, symbol))
                {
                    return member;
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Map a symbol to all of its in-source locations.
    /// Source-generated symbols (e.g. from ISourceGenerator / IIncrementalGenerator)
    /// have IsInSource = true with a valid SourceTree, so this filter captures them.
    /// Navigation FROM generated files requires WorkspaceManager.FindDocumentAsync
    /// to resolve source-generated documents via Project.GetSourceGeneratedDocumentsAsync.
    /// </summary>
    private static LocationListResult ToAllSourceLocations(ISymbol symbol)
    {
        var locations = new List<LocationResult>();
        foreach (var location in symbol.Locations.Where(l => l.IsInSource))
        {
            locations.Add(DocumentPosition.ToLocationResult(location.GetMappedLineSpan()));
        }

        return new LocationListResult { Locations = locations };
    }

    /// <summary>
    /// Map a symbol to its first in-source location.
    /// Roslyn marks source-generated locations as IsInSource = true,
    /// so no special handling is needed for source generator output.
    /// </summary>
    internal static LocationResult? ToFirstSourceLocation(ISymbol symbol)
    {
        var location = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        return location is null
            ? null
            : DocumentPosition.ToLocationResult(location.GetMappedLineSpan());
    }
}
