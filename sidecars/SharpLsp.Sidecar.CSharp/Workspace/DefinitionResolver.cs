using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves symbol locations for go-to-definition, type definition,
/// declaration, and implementation requests via Roslyn.
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
    private static async Task<LocationListResult> ResolveSymbolLocationsAsync(
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

    /// <summary>Find all implementations of the symbol at a position.</summary>
    public static async Task<LocationListResult> ResolveImplementationsAsync(
        Document document,
        Solution solution,
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
                    if (
                        symbol is IMethodSymbol or IPropertySymbol
                        && (symbol.IsVirtual || symbol.IsAbstract || symbol.IsOverride)
                    )
                    {
                        await FindOverridesViaDerivedTypesAsync(symbol, solution, locations, ct)
                            .ConfigureAwait(false);
                    }

                    // If no implementations found, include the symbol's own location.
                    // Matches VS/Rider: "Go to Implementation" on a concrete type navigates
                    // to itself when nothing derives from or implements it.
                    if (locations.Count == 0)
                    {
                        AddSourceLocation(locations, symbol);
                    }

                    return new LocationListResult { Locations = locations };
                },
                ct
            )
            .ConfigureAwait(false);
    }

    /// <summary>Find all references to the symbol at a position across the solution.</summary>
    public static async Task<LocationListResult> ResolveReferencesAsync(
        Document document,
        Solution solution,
        int line,
        int character,
        bool includeDeclaration,
        CancellationToken ct
    )
    {
        return await ResolveSymbolLocationsAsync(
                document,
                line,
                character,
                async symbol =>
                {
                    var locations = new List<LocationResult>();
                    var referencedSymbols = await SymbolFinder
                        .FindReferencesAsync(symbol, solution, cancellationToken: ct)
                        .ConfigureAwait(false);

                    foreach (var refSymbol in referencedSymbols)
                    {
                        if (includeDeclaration)
                        {
                            AddSourceLocation(locations, refSymbol.Definition);
                        }

                        foreach (var refLoc in refSymbol.Locations)
                        {
                            var span = refLoc.Location.GetMappedLineSpan();
                            if (span.IsValid && refLoc.Location.IsInSource)
                            {
                                locations.Add(DocumentPosition.ToLocationResult(span));
                            }
                        }
                    }

                    return new LocationListResult { Locations = locations };
                },
                ct
            )
            .ConfigureAwait(false);
    }

    /// <summary>Find document highlights for the symbol at a position (current doc only).</summary>
    public static async Task<List<DocumentHighlightResult>> ResolveDocumentHighlightsAsync(
        Document document,
        Solution solution,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await ResolveSymbolAsync(document, line, character, ct).ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        var highlights = new List<DocumentHighlightResult>();
        var referencedSymbols = await SymbolFinder
            .FindReferencesAsync(symbol, solution, cancellationToken: ct)
            .ConfigureAwait(false);

        foreach (var refSymbol in referencedSymbols)
        {
            // Include declaration as Write.
            foreach (var loc in refSymbol.Definition.Locations)
            {
                if (!loc.IsInSource || loc.SourceTree?.FilePath != document.FilePath)
                {
                    continue;
                }

                var declSpan = loc.GetMappedLineSpan();
                if (declSpan.IsValid)
                {
                    highlights.Add(
                        new DocumentHighlightResult
                        {
                            StartLine = declSpan.StartLinePosition.Line,
                            StartCharacter = declSpan.StartLinePosition.Character,
                            EndLine = declSpan.EndLinePosition.Line,
                            EndCharacter = declSpan.EndLinePosition.Character,
                            Kind = 3, // Write
                        }
                    );
                }
            }

            // Include references, classifying as Read vs Write.
            foreach (var refLoc in refSymbol.Locations)
            {
                if (refLoc.Document.Id != document.Id)
                {
                    continue;
                }

                var span = refLoc.Location.GetMappedLineSpan();
                if (!span.IsValid)
                {
                    continue;
                }

                var kind = IsWriteReference(refLoc) ? 3 : 2;
                highlights.Add(
                    new DocumentHighlightResult
                    {
                        StartLine = span.StartLinePosition.Line,
                        StartCharacter = span.StartLinePosition.Character,
                        EndLine = span.EndLinePosition.Line,
                        EndCharacter = span.EndLinePosition.Character,
                        Kind = kind,
                    }
                );
            }
        }

        return highlights;
    }

    /// <summary>Check if a reference location is a write (assignment, out/ref, increment/decrement).</summary>
    private static bool IsWriteReference(ReferenceLocation refLoc)
    {
        if (refLoc.IsImplicit)
        {
            return true;
        }

        var node = refLoc.Location.SourceTree?.GetRoot().FindNode(refLoc.Location.SourceSpan);
        return node is not null && IsWriteContext(node);
    }

    /// <summary>Check if a syntax node is in a write context.</summary>
    private static bool IsWriteContext(SyntaxNode node)
    {
        var parent = node.Parent;
        return parent switch
        {
            // x = value
            AssignmentExpressionSyntax assign => assign.Left == node,
            // out x, ref x
            ArgumentSyntax { RefKindKeyword.RawKind: var kind }
                when kind is (int)SyntaxKind.OutKeyword or (int)SyntaxKind.RefKeyword => true,
            // x++, x--, ++x, --x
            PostfixUnaryExpressionSyntax => true,
            PrefixUnaryExpressionSyntax prefix
                when prefix.IsKind(SyntaxKind.PreIncrementExpression)
                    || prefix.IsKind(SyntaxKind.PreDecrementExpression) => true,
            _ => false,
        };
    }

    /// <summary>Resolve the symbol at a given document position.</summary>
    private static async Task<ISymbol?> ResolveSymbolAsync(
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

        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root is null)
        {
            return null;
        }

        var token = root.FindToken(position);
        if (token.Parent is null)
        {
            Log.Debug("[Resolve] token.Parent is null");
            return null;
        }

        // Try reference resolution first (call sites, type references).
        var symbolInfo = model.GetSymbolInfo(token.Parent, ct);
        var symbol = symbolInfo.Symbol ?? symbolInfo.CandidateSymbols.FirstOrDefault();
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
    /// Find overrides of a virtual/abstract member by walking derived types.
    /// This is more reliable than FindOverridesAsync with MSBuildWorkspace.
    /// </summary>
    private static async Task FindOverridesViaDerivedTypesAsync(
        ISymbol symbol,
        Solution solution,
        List<LocationResult> locations,
        CancellationToken ct
    )
    {
        var containingType = symbol.ContainingType;
        if (containingType is null)
        {
            return;
        }

        Log.Debug(
            "[Override] Looking for overrides of {Type}.{Member}",
            containingType.Name,
            symbol.Name
        );

        var derivedTypes = await SymbolFinder
            .FindDerivedClassesAsync(containingType, solution, cancellationToken: ct)
            .ConfigureAwait(false);

        Log.Debug("[Override] Found {Count} derived types", derivedTypes.Count());

        foreach (var derived in derivedTypes)
        {
            Log.Debug("[Override] Checking {Type}", derived.Name);
            foreach (var member in derived.GetMembers(symbol.Name))
            {
                Log.Debug(
                    "[Override] Member {Member} override={IsOverride}",
                    member.Name,
                    member.IsOverride
                );
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
    private static LocationResult? ToFirstSourceLocation(ISymbol symbol)
    {
        var location = symbol.Locations.FirstOrDefault(l => l.IsInSource);
        return location is null
            ? null
            : DocumentPosition.ToLocationResult(location.GetMappedLineSpan());
    }
}
