using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CSharp;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// The row that imports only the type: <c>using T = N.T;</c> for each namespace a namespace row
/// imports that declares a non-generic type named exactly <c>T</c>. Implements the alias row of
/// [REFACTOR-IMPORT-CSHARP].
/// </summary>
internal static class AliasImportFixes
{
    /// <summary>One alias row per namespace in <paramref name="namespaces"/> that declares the type.</summary>
    public static async Task<ImmutableArray<ImportFix>> OfferAsync(
        Document document,
        ImportSubject subject,
        IEnumerable<string> namespaces,
        CancellationToken ct
    )
    {
        var compilation = await document.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        return compilation is null || subject.Arity > 0
            ? []
            :
            [
                .. namespaces
                    .Distinct(StringComparer.Ordinal)
                    .Select(ns => compilation.GetTypeByMetadataName($"{ns}.{subject.Text}"))
                    .OfType<INamedTypeSymbol>()
                    .Where(type => compilation.IsSymbolAccessibleWithin(type, compilation.Assembly))
                    .Select(type => Fix(document, subject.Text, ImportNames.FullName(type))),
            ];
    }

    private static ImportFix Fix(Document document, string name, string fullName)
    {
        var title = ImportTitles.Alias(name, fullName);
        var directive = SyntaxFactory.UsingDirective(
            SyntaxFactory.NameEquals(name),
            SyntaxFactory.ParseName(fullName)
        );
        return ImportFix.InReach(
            CodeAction.Create(title, ct => UsingInsertion.AddAsync(document, directive, ct), title)
        );
    }
}
