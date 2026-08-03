using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Roslyn dead-code analyzer — the C# half of the cross-language monorepo
/// dead-code feature (the F# half emits <c>SLSPF0101</c>). A declared symbol with
/// no semantic references anywhere in the loaded solution is dead.
///
/// Implements [ANALYZERS-UNUSED-PUBLIC] / [ANALYZERS-DEADCODE-SEVERITY]:
///   * Public symbols are reported only in monorepo mode (the repo is the whole
///     world), as an <b>error</b>.
///   * Internal/private symbols are reported regardless of monorepo mode — they
///     are assembly-bounded, so their deadness is sound — as a warning (or an
///     error in monorepo mode).
///   * Protected members are skipped (an external subclass may override them).
///
/// Reference identity comes from <see cref="SymbolFinder"/>, never string matching.
/// </summary>
internal static class DeadCodeAnalyzer
{
    /// <summary>Diagnostic code for unused C# symbols (see the spec).</summary>
    public const string DiagnosticCode = "SLSPC0101";

    /// <summary>Analyze one document and return dead-code diagnostics for it.</summary>
    public static async Task<List<DiagnosticResult>> AnalyzeAsync(
        Document document,
        Solution solution,
        bool monorepo,
        CancellationToken ct
    )
    {
        var results = new List<DiagnosticResult>();
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return results;
        }

        var filePath = document.FilePath ?? "";
        foreach (var node in root.DescendantNodes())
        {
            ct.ThrowIfCancellationRequested();
            if (!IsDeclaration(node))
            {
                continue;
            }

            var symbol = model.GetDeclaredSymbol(node, ct);
            if (symbol is null || !IsCandidate(symbol))
            {
                continue;
            }

            var diagnostic = await ClassifyAsync(symbol, node, filePath, solution, monorepo, ct)
                .ConfigureAwait(false);
            if (diagnostic is not null)
            {
                results.Add(diagnostic);
            }
        }

        return results;
    }

    private static bool IsDeclaration(SyntaxNode node)
    {
        return node
            is TypeDeclarationSyntax
                or EnumDeclarationSyntax
                or MethodDeclarationSyntax
                or PropertyDeclarationSyntax;
    }

    /// <summary>
    /// Conservative candidate filter: skip anything that is reached indirectly
    /// (overrides, abstract contracts, attributed/reflection-bound, entry points,
    /// accessors) so the analyzer prefers silence over false positives.
    /// </summary>
    private static bool IsCandidate(ISymbol symbol)
    {
        if (symbol.IsImplicitlyDeclared || symbol.IsOverride)
        {
            return false;
        }

        // Abstract MEMBERS are contracts implemented by overrides; abstract TYPES
        // (abstract classes, interfaces) are still dead when nothing uses them.
        if (symbol is not INamedTypeSymbol && symbol.IsAbstract)
        {
            return false;
        }

        // Reflection, DI, serialization, and routing reach attributed members.
        if (symbol.GetAttributes().Length > 0)
        {
            return false;
        }

        if (symbol is IMethodSymbol method)
        {
            if (method.IsStatic && method.Name == "Main")
            {
                return false;
            }

            if (!method.ExplicitInterfaceImplementations.IsEmpty)
            {
                return false;
            }
        }

        return Visibility(symbol) is not null;
    }

    /// <summary>
    /// Classify accessibility into the gate bucket, or <c>null</c> to skip:
    /// <c>true</c> = externally visible (public), <c>false</c> = assembly-bounded
    /// (internal/private). Protected variants return <c>null</c> (skip).
    /// </summary>
    private static bool? Visibility(ISymbol symbol)
    {
        return symbol.DeclaredAccessibility == Accessibility.Public ? true
            : symbol.DeclaredAccessibility is Accessibility.Internal or Accessibility.Private
                ? false
            : null;
    }

    private static async Task<DiagnosticResult?> ClassifyAsync(
        ISymbol symbol,
        SyntaxNode node,
        string filePath,
        Solution solution,
        bool monorepo,
        CancellationToken ct
    )
    {
        var isPublic = Visibility(symbol) == true;
        // Public symbols are an external API unless the repo is the whole world.
        if (isPublic && !monorepo)
        {
            return null;
        }

        if (await HasReferencesAsync(symbol, solution, ct).ConfigureAwait(false))
        {
            return null;
        }

        var span = IdentifierLocation(node).GetMappedLineSpan();
        if (!span.IsValid)
        {
            return null;
        }

        var severity = monorepo ? "Error" : "Warning";
        var message = isPublic
            ? $"Public {KindLabel(symbol)} '{symbol.Name}' has no references in the configured monorepo."
            : $"Dead code: {KindLabel(symbol)} '{symbol.Name}' has no references in the solution.";

        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = span.StartLinePosition.Line,
            StartCharacter = span.StartLinePosition.Character,
            EndLine = span.EndLinePosition.Line,
            EndCharacter = span.EndLinePosition.Character,
            Message = message,
            Severity = severity,
            Code = DiagnosticCode,
        };
    }

    private static async Task<bool> HasReferencesAsync(
        ISymbol symbol,
        Solution solution,
        CancellationToken ct
    )
    {
        try
        {
            var refs = await SymbolFinder
                .FindReferencesAsync(symbol, solution, cancellationToken: ct)
                .ConfigureAwait(false);
            return refs.Any(r => r.Locations.Any());
        }
        catch (Exception) when (!ct.IsCancellationRequested)
        {
            // On any analysis failure, prefer silence (do not flag as dead).
            return true;
        }
    }

    private static Location IdentifierLocation(SyntaxNode node)
    {
        return node switch
        {
            TypeDeclarationSyntax type => type.Identifier.GetLocation(),
            EnumDeclarationSyntax enumType => enumType.Identifier.GetLocation(),
            MethodDeclarationSyntax method => method.Identifier.GetLocation(),
            PropertyDeclarationSyntax property => property.Identifier.GetLocation(),
            _ => node.GetLocation(),
        };
    }

    private static string KindLabel(ISymbol symbol)
    {
        return symbol switch
        {
            INamedTypeSymbol named => TypeKindLabel(named.TypeKind),
            IMethodSymbol => "method",
            IPropertySymbol => "property",
            _ => "symbol",
        };
    }

    private static string TypeKindLabel(TypeKind kind)
    {
        return kind == TypeKind.Interface ? "interface"
            : kind == TypeKind.Struct ? "struct"
            : kind == TypeKind.Enum ? "enum"
            : "type";
    }
}
