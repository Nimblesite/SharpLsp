using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves the requests that search beyond the symbol's own declaration — implementations,
/// references and document highlights — in each project's active framework, each place once.
/// Implements [NETFX-PROJECTS-CSHARP].
/// </summary>
internal static class ReferenceResolver
{
    /// <summary>LSP <c>DocumentHighlightKind.Read</c>.</summary>
    private const int ReadKind = 2;

    /// <summary>LSP <c>DocumentHighlightKind.Write</c>.</summary>
    private const int WriteKind = 3;

    /// <summary>Find all implementations of the symbol at a position.</summary>
    public static async Task<LocationListResult> ResolveImplementationsAsync(
        Document document,
        SearchScope scope,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return await DefinitionResolver
            .ResolveSymbolLocationsAsync(
                document,
                line,
                character,
                async symbol =>
                    Distinct(await ImplementationsOfAsync(symbol, scope, ct).ConfigureAwait(false)),
                ct
            )
            .ConfigureAwait(false);
    }

    /// <summary>Find all references to the symbol at a position.</summary>
    public static async Task<LocationListResult> ResolveReferencesAsync(
        Document document,
        SearchScope scope,
        int line,
        int character,
        bool includeDeclaration,
        CancellationToken ct
    )
    {
        return await DefinitionResolver
            .ResolveSymbolLocationsAsync(
                document,
                line,
                character,
                async symbol =>
                    Distinct(
                        ReferenceLocations(
                            await scope.FindReferencesAsync(symbol, ct).ConfigureAwait(false),
                            includeDeclaration
                        )
                    ),
                ct
            )
            .ConfigureAwait(false);
    }

    /// <summary>Find document highlights for the symbol at a position: this document only.</summary>
    public static async Task<List<DocumentHighlightResult>> ResolveDocumentHighlightsAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var symbol = await DefinitionResolver
            .ResolveSymbolAsync(document, line, character, ct)
            .ConfigureAwait(false);
        if (symbol is null)
        {
            return [];
        }

        // A highlight never leaves the document, so no other document is searched.
        var referenced = await SymbolFinder
            .FindReferencesAsync(symbol, document.Project.Solution, [document], ct)
            .ConfigureAwait(false);
        return
        [
            .. referenced
                .SelectMany(reference => HighlightsIn(document, reference))
                .DistinctBy(highlight =>
                    (
                        highlight.StartLine,
                        highlight.StartCharacter,
                        highlight.EndLine,
                        highlight.EndCharacter
                    )
                ),
        ];
    }

    /// <summary>
    /// The symbol's implementations and, for a virtual or abstract member, its overrides — else
    /// the symbol itself: as in Visual Studio and Rider, "Go to Implementation" on a concrete type
    /// that nothing derives from or implements navigates to that type.
    /// </summary>
    private static async Task<List<LocationResult>> ImplementationsOfAsync(
        ISymbol symbol,
        SearchScope scope,
        CancellationToken ct
    )
    {
        // FindImplementationsAsync handles interfaces and abstract members.
        var found = await scope.FindImplementationsAsync(symbol, ct).ConfigureAwait(false);
        if (
            symbol is IMethodSymbol or IPropertySymbol
            && (symbol.IsVirtual || symbol.IsAbstract || symbol.IsOverride)
        )
        {
            found.AddRange(await OverridesOfAsync(symbol, scope, ct).ConfigureAwait(false));
        }

        var locations = SourceLocationsOf(found);
        return locations.Count > 0 ? locations : SourceLocationsOf([symbol]);
    }

    /// <summary>
    /// Overrides of a virtual or abstract member, found by walking the types derived from its
    /// type: more reliable than FindOverridesAsync with MSBuildWorkspace.
    /// </summary>
    private static async Task<IEnumerable<ISymbol>> OverridesOfAsync(
        ISymbol symbol,
        SearchScope scope,
        CancellationToken ct
    )
    {
        if (symbol.ContainingType is not { } containingType)
        {
            return [];
        }

        var derived = await scope.FindDerivedClassesAsync(containingType, ct).ConfigureAwait(false);
        Log.Debug(
            "[Override] {Count} types derive from {Type}, searched for {Member}",
            derived.Count,
            containingType.Name,
            symbol.Name
        );
        return derived
            .SelectMany(type => type.GetMembers(symbol.Name))
            .Where(member => member.IsOverride);
    }

    /// <summary>Each referenced symbol's uses in source, after its declaration when asked for.</summary>
    private static IEnumerable<LocationResult> ReferenceLocations(
        IEnumerable<ReferencedSymbol> referenced,
        bool includeDeclaration
    )
    {
        foreach (var reference in referenced)
        {
            if (
                includeDeclaration
                && DeclaresItself(reference)
                && DefinitionResolver.ToFirstSourceLocation(reference.Definition) is { } declared
            )
            {
                yield return declared;
            }

            foreach (var use in reference.Locations.Where(use => use.Location.IsInSource))
            {
                var span = use.Location.GetMappedLineSpan();
                if (span.IsValid)
                {
                    yield return DocumentPosition.ToLocationResult(span);
                }
            }
        }
    }

    /// <summary>Each symbol's first source location.</summary>
    private static List<LocationResult> SourceLocationsOf(IEnumerable<ISymbol> symbols)
    {
        return
        [
            .. symbols.Select(DefinitionResolver.ToFirstSourceLocation).OfType<LocationResult>(),
        ];
    }

    /// <summary>Each place once: one place is found through every symbol that names it.</summary>
    private static LocationListResult Distinct(IEnumerable<LocationResult> locations)
    {
        return new LocationListResult
        {
            Locations =
            [
                .. locations.DistinctBy(location =>
                    (
                        location.FilePath,
                        location.Line,
                        location.Character,
                        location.EndLine,
                        location.EndCharacter
                    )
                ),
            ],
        };
    }

    /// <summary>One referenced symbol's declaration (a write) and its uses in the document.</summary>
    private static IEnumerable<DocumentHighlightResult> HighlightsIn(
        Document document,
        ReferencedSymbol reference
    )
    {
        var declarations = reference
            .Definition.Locations.Where(location =>
                DeclaresItself(reference)
                && location.IsInSource
                && location.SourceTree?.FilePath == document.FilePath
            )
            .Select(location => ToHighlight(location, WriteKind));
        var uses = reference
            .Locations.Where(use => use.Document.Id == document.Id)
            .Select(use => ToHighlight(use.Location, IsWriteReference(use) ? WriteKind : ReadKind));
        return declarations.Concat(uses).OfType<DocumentHighlightResult>();
    }

    /// <summary>
    /// False for an accessor Roslyn searched along with its property: the property's
    /// declaration is the one a request means, and the getter of an expression-bodied
    /// property is declared at its expression.
    /// </summary>
    private static bool DeclaresItself(ReferencedSymbol reference)
    {
        return reference.Definition is not IMethodSymbol { AssociatedSymbol: not null };
    }

    private static DocumentHighlightResult? ToHighlight(Location location, int kind)
    {
        var span = location.GetMappedLineSpan();
        return span.IsValid
            ? new DocumentHighlightResult
            {
                StartLine = span.StartLinePosition.Line,
                StartCharacter = span.StartLinePosition.Character,
                EndLine = span.EndLinePosition.Line,
                EndCharacter = span.EndLinePosition.Character,
                Kind = kind,
            }
            : null;
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
}
