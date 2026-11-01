using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// Adds one using directive where a person would put it: with the file's other usings, among its
/// own kind (plain, then static, then alias), <c>System</c> first and sorted. A file with no
/// usings gets it above everything, its header comments kept on top, and a blank line after.
/// Implements the edit of the SharpLsp-owned rows of [REFACTOR-IMPORT-CSHARP].
/// </summary>
internal static class UsingInsertion
{
    /// <summary>The file's using directives at file and namespace level.</summary>
    public static IEnumerable<UsingDirectiveSyntax> AllUsings(CompilationUnitSyntax root)
    {
        return root.DescendantNodes(node =>
                node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax
            )
            .OfType<UsingDirectiveSyntax>();
    }

    /// <summary><paramref name="document"/> with <paramref name="directive"/> added, unless it is already there.</summary>
    public static async Task<Document> AddAsync(
        Document document,
        UsingDirectiveSyntax directive,
        CancellationToken ct
    )
    {
        var found = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (
            found is not CompilationUnitSyntax root
            || AllUsings(root).Any(old => SyntaxFactory.AreEquivalent(old, directive))
        )
        {
            return document;
        }
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var line = SyntaxFactory.EndOfLine(NewLineOf(text));
        return document.WithSyntaxRoot(Insert(root, directive.NormalizeWhitespace(), line));
    }

    private static CompilationUnitSyntax Insert(
        CompilationUnitSyntax root,
        UsingDirectiveSyntax directive,
        SyntaxTrivia line
    )
    {
        if (root.Usings.Count > 0 || NamespaceWithUsings(root) is not { } scope)
        {
            return root.Usings.Count > 0
                ? root.WithUsings(Sorted(root.Usings, directive.WithTrailingTrivia(line)))
                : First(root, directive, line);
        }
        var indented = directive
            .WithLeadingTrivia(scope.Usings[0].GetLeadingTrivia())
            .WithTrailingTrivia(line);
        return root.ReplaceNode(scope, scope.WithUsings(Sorted(scope.Usings, indented)));
    }

    private static BaseNamespaceDeclarationSyntax? NamespaceWithUsings(CompilationUnitSyntax root)
    {
        return root.DescendantNodes(node =>
                node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax
            )
            .OfType<BaseNamespaceDeclarationSyntax>()
            .FirstOrDefault(scope => scope.Usings.Count > 0);
    }

    /// <summary>The first directive of the file: it takes the header, and a blank line follows it.</summary>
    private static CompilationUnitSyntax First(
        CompilationUnitSyntax root,
        UsingDirectiveSyntax directive,
        SyntaxTrivia line
    )
    {
        var first = root.GetFirstToken(includeZeroWidth: true);
        var placed = directive.WithLeadingTrivia(first.LeadingTrivia).WithTrailingTrivia(line);
        var spaced = root.ReplaceToken(first, first.WithLeadingTrivia(line));
        return spaced.WithUsings(SyntaxFactory.SingletonList(placed));
    }

    private static SyntaxList<UsingDirectiveSyntax> Sorted(
        SyntaxList<UsingDirectiveSyntax> usings,
        UsingDirectiveSyntax directive
    )
    {
        var index = usings.IndexOf(existing => Compare(existing, directive) > 0);
        return index < 0 ? usings.Add(directive) : usings.Insert(index, directive);
    }

    /// <summary>Plain before static before alias; within a kind, System first, then ordinal.</summary>
    private static int Compare(UsingDirectiveSyntax left, UsingDirectiveSyntax right)
    {
        var byKind = Kind(left).CompareTo(Kind(right));
        var bySystem = IsSystem(right).CompareTo(IsSystem(left));
        return byKind != 0 ? byKind
            : bySystem != 0 ? bySystem
            : string.CompareOrdinal(SortName(left), SortName(right));
    }

    private static int Kind(UsingDirectiveSyntax directive)
    {
        return directive.Alias is not null ? 2
            : directive.StaticKeyword.IsKind(SyntaxKind.StaticKeyword) ? 1
            : 0;
    }

    private static string SortName(UsingDirectiveSyntax directive)
    {
        return directive.Alias?.Name.Identifier.ValueText ?? directive.NamespaceOrType.ToString();
    }

    /// <summary>Whether the directive's name starts at the <c>System</c> namespace, read from its syntax.</summary>
    private static bool IsSystem(UsingDirectiveSyntax directive)
    {
        return directive.Alias is null
            && Leftmost(directive.NamespaceOrType) is { Identifier.ValueText: "System" };
    }

    private static IdentifierNameSyntax? Leftmost(TypeSyntax type)
    {
        return type switch
        {
            QualifiedNameSyntax qualified => Leftmost(qualified.Left),
            AliasQualifiedNameSyntax aliased => Leftmost(aliased.Name),
            IdentifierNameSyntax identifier => identifier,
            _ => null,
        };
    }

    /// <summary>The line break the file already uses, or a line feed for a one-line file.</summary>
    private static string NewLineOf(SourceText text)
    {
        var first = text.Lines[0];
        return first.EndIncludingLineBreak > first.End
            ? text.ToString(TextSpan.FromBounds(first.End, first.EndIncludingLineBreak))
            : "\n";
    }
}
