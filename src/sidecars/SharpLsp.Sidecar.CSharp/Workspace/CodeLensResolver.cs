using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Computes code lenses (reference counts, implementation counts) for types and members.
/// </summary>
internal static class CodeLensResolver
{
    /// <summary>Get code lenses for a document.</summary>
    public static async Task<List<CodeLensResult>> GetLensesAsync(
        Document document,
        Solution solution,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return [];
        }

        var lenses = new List<CodeLensResult>();
        await CollectLensesAsync(root, model, solution, lenses, ct).ConfigureAwait(false);
        return lenses;
    }

    private static async Task CollectLensesAsync(
        SyntaxNode root,
        SemanticModel model,
        Solution solution,
        List<CodeLensResult> lenses,
        CancellationToken ct
    )
    {
        foreach (var node in root.DescendantNodes())
        {
            ct.ThrowIfCancellationRequested();
            if (
                node
                is not (
                    TypeDeclarationSyntax
                    or MethodDeclarationSyntax
                    or PropertyDeclarationSyntax
                    or ConstructorDeclarationSyntax
                )
            )
            {
                continue;
            }

            var symbol = model.GetDeclaredSymbol(node, ct);
            if (symbol is null)
            {
                continue;
            }

            var span = node.GetLocation().GetMappedLineSpan();
            if (!span.IsValid)
            {
                continue;
            }

            var refCount = await CountReferencesAsync(symbol, solution, ct).ConfigureAwait(false);
            lenses.Add(
                new CodeLensResult
                {
                    Line = span.StartLinePosition.Line,
                    Character = span.StartLinePosition.Character,
                    Title = FormatRefTitle(refCount),
                }
            );

            // Add implementation count for interfaces and abstract classes.
            if (
                symbol is INamedTypeSymbol implSymbol
                && (implSymbol.TypeKind is TypeKind.Interface || implSymbol.IsAbstract)
            )
            {
                var implCount = await CountImplementationsAsync(implSymbol, solution, ct)
                    .ConfigureAwait(false);
                lenses.Add(
                    new CodeLensResult
                    {
                        Line = span.StartLinePosition.Line,
                        Character = span.StartLinePosition.Character,
                        Title = FormatImplTitle(implCount),
                    }
                );
            }
        }
    }

    private static async Task<int> CountReferencesAsync(
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
            return refs.Sum(r => r.Locations.Count());
        }
        catch
        {
            return 0;
        }
    }

    private static async Task<int> CountImplementationsAsync(
        INamedTypeSymbol typeSymbol,
        Solution solution,
        CancellationToken ct
    )
    {
        try
        {
            var impls = await SymbolFinder
                .FindImplementationsAsync(typeSymbol, solution, cancellationToken: ct)
                .ConfigureAwait(false);
            return impls.Count();
        }
        catch
        {
            return 0;
        }
    }

    private static string FormatRefTitle(int count)
    {
        return count switch
        {
            0 => "0 references",
            1 => "1 reference",
            _ => $"{count} references",
        };
    }

    private static string FormatImplTitle(int count)
    {
        return count switch
        {
            0 => "0 implementations",
            1 => "1 implementation",
            _ => $"{count} implementations",
        };
    }
}
