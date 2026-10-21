using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Computes code lenses (reference counts, implementation counts) for types and members,
/// counted in each project's active framework ([NETFX-PROJECTS-CSHARP]).
/// </summary>
internal static class CodeLensResolver
{
    /// <summary>
    /// Get code lenses for a document, each on its declaration. A declaration <paramref name="place"/>
    /// moves is lensed where it puts it, and one it maps nowhere has no lens: that is how a Razor
    /// file's lenses land on the declarations in its C# fragments ([RAZOR-FEATURES-CODE-LENS]).
    /// </summary>
    public static async Task<List<CodeLensResult>> GetLensesAsync(
        Document document,
        SearchScope scope,
        CancellationToken ct,
        Func<LinePositionSpan, LinePositionSpan?>? place = null
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (root is null || model is null)
        {
            return [];
        }

        var lenses = new List<CodeLensResult>();
        await CollectLensesAsync(root, model, scope, lenses, place, ct).ConfigureAwait(false);
        return lenses;
    }

    private static async Task CollectLensesAsync(
        SyntaxNode root,
        SemanticModel model,
        SearchScope scope,
        List<CodeLensResult> lenses,
        Func<LinePositionSpan, LinePositionSpan?>? place,
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
            if (symbol is null || Declared(node, place) is not { } span)
            {
                continue;
            }

            var refCount = await CountReferencesAsync(symbol, scope, ct).ConfigureAwait(false);
            lenses.Add(LensAt(span, FormatRefTitle(refCount)));

            // Add implementation count for interfaces and abstract classes.
            if (
                symbol is INamedTypeSymbol implSymbol
                && (implSymbol.TypeKind is TypeKind.Interface || implSymbol.IsAbstract)
            )
            {
                var implCount = await CountImplementationsAsync(implSymbol, scope, ct)
                    .ConfigureAwait(false);
                lenses.Add(LensAt(span, FormatImplTitle(implCount)));
            }
        }
    }

    /// <summary>
    /// Where the lens for <paramref name="node"/> sits: its declaration's own mapped range, or,
    /// when <paramref name="place"/> maps it, that range in the file it belongs to; null when the
    /// declaration maps nowhere and its lens is dropped.
    /// </summary>
    private static FileLinePositionSpan? Declared(
        SyntaxNode node,
        Func<LinePositionSpan, LinePositionSpan?>? place
    )
    {
        var location = node.GetLocation();
        if (place is null)
        {
            var mapped = location.GetMappedLineSpan();
            return mapped.IsValid ? mapped : null;
        }

        return place(location.GetLineSpan().Span) is { } placed
            ? new FileLinePositionSpan(location.SourceTree?.FilePath ?? "", placed)
            : null;
    }

    /// <summary>A lens titled <paramref name="title"/> at the start of <paramref name="span"/>.</summary>
    private static CodeLensResult LensAt(FileLinePositionSpan span, string title)
    {
        return new CodeLensResult
        {
            Line = span.StartLinePosition.Line,
            Character = span.StartLinePosition.Character,
            Title = title,
        };
    }

    private static async Task<int> CountReferencesAsync(
        ISymbol symbol,
        SearchScope scope,
        CancellationToken ct
    )
    {
        try
        {
            var refs = await scope.FindReferencesAsync(symbol, ct).ConfigureAwait(false);
            return SearchScope.DistinctLocations(refs).Count();
        }
        catch
        {
            return 0;
        }
    }

    private static async Task<int> CountImplementationsAsync(
        INamedTypeSymbol typeSymbol,
        SearchScope scope,
        CancellationToken ct
    )
    {
        try
        {
            var impls = await scope.FindImplementationsAsync(typeSymbol, ct).ConfigureAwait(false);
            return impls.Count;
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
