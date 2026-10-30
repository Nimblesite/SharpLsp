using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// The pure syntax of moving a type out: shortening a qualified reference, qualifying
/// what the type borrowed from its container, rewriting its accessibility, and the
/// new file around it. Implements [REFACTOR-MOVE-TYPE-OUT].
/// </summary>
internal static class MoveTypeOutSyntax
{
    /// <summary>
    /// The `Container.Name` node that <paramref name="name"/> is the last segment of, or
    /// null when the reference is already the bare name.
    /// </summary>
    public static SyntaxNode? QualifiedParent(SimpleNameSyntax name)
    {
        return name.Parent switch
        {
            QualifiedNameSyntax qualified when qualified.Right == name => qualified,
            MemberAccessExpressionSyntax access when access.Name == name => access,
            _ => null,
        };
    }

    /// <summary>
    /// <paramref name="qualified"/> with its last container dropped: `Outer.Inner` becomes
    /// `Inner`, `Geo.Outer.Inner` becomes `Geo.Inner`, `global::Outer.Inner` becomes
    /// `global::Inner`.
    /// </summary>
    public static SyntaxNode WithoutContainer(SyntaxNode qualified, SimpleNameSyntax name)
    {
        var container = qualified switch
        {
            QualifiedNameSyntax q => q.Left,
            MemberAccessExpressionSyntax m => m.Expression,
            _ => null,
        };
        SyntaxNode shortened = container switch
        {
            QualifiedNameSyntax outer => outer.WithRight(name),
            MemberAccessExpressionSyntax outer => outer.WithName(name),
            AliasQualifiedNameSyntax alias => alias.WithName(name),
            _ => name,
        };
        return shortened.WithTriviaFrom(qualified);
    }

    /// <summary>
    /// The declaration with every bare reference to an accessible static member or
    /// nested type of an enclosing type qualified by that type, so it resolves from outside.
    /// </summary>
    public static BaseTypeDeclarationSyntax QualifyEnclosingMembers(
        MoveTypeOutTarget target,
        SemanticModel model,
        CancellationToken ct
    )
    {
        var borrowed = target
            .Declaration.DescendantNodes()
            .OfType<SimpleNameSyntax>()
            .Where(name => QualifiedParent(name) is null)
            .Select(name => (name, model.GetSymbolInfo(name, ct).Symbol))
            .Where(pair => IsBorrowed(target, pair.Symbol))
            .ToDictionary(pair => pair.name, pair => pair.Symbol!);
        return target.Declaration.ReplaceNodes(
            borrowed.Keys,
            (name, _) => Qualified(borrowed[name], name)
        );
    }

    /// <summary>A member or nested type of an enclosing type, named without it.</summary>
    private static bool IsBorrowed(MoveTypeOutTarget target, ISymbol? symbol)
    {
        return symbol is not null
            && symbol is not INamespaceSymbol
            && symbol.ContainingType is { } owner
            && target.IsEnclosing(owner)
            && !target.IsInsideMoved(symbol)
            && !(symbol is INamedTypeSymbol type && target.IsEnclosing(type));
    }

    private static SyntaxNode Qualified(ISymbol symbol, SimpleNameSyntax name)
    {
        var owner = symbol
            .ContainingType.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
        var bare = name.WithoutTrivia();
        SyntaxNode qualified = symbol is ITypeSymbol
            ? QualifiedName(ParseName(owner), bare)
            : MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression, ParseExpression(owner), bare);
        return qualified.WithTriviaFrom(name);
    }

    /// <summary>
    /// The declaration with namespace-level accessibility: `public` stays, everything else
    /// (including no modifier, which means `private` in a type) becomes `internal`, and a
    /// `new` hiding modifier has nothing left to hide.
    /// </summary>
    public static BaseTypeDeclarationSyntax AtNamespaceLevel(BaseTypeDeclarationSyntax declaration)
    {
        var leading = declaration.GetLeadingTrivia();
        var kept = declaration
            .Modifiers.Where(modifier => !IsAccessibility(modifier) && !modifier.IsKind(SyntaxKind.NewKeyword))
            .Select(modifier => modifier.WithoutTrivia().WithTrailingTrivia(Space));
        var access = declaration.Modifiers.Any(SyntaxKind.PublicKeyword)
            ? SyntaxKind.PublicKeyword
            : SyntaxKind.InternalKeyword;
        var modifiers = TokenList(kept.Prepend(Token(access).WithTrailingTrivia(Space)));
        return declaration
            .WithoutLeadingTrivia()
            .WithModifiers(modifiers)
            .WithLeadingTrivia(leading);
    }

    private static bool IsAccessibility(SyntaxToken modifier)
    {
        return modifier.Kind()
            is SyntaxKind.PublicKeyword
                or SyntaxKind.InternalKeyword
                or SyntaxKind.PrivateKeyword
                or SyntaxKind.ProtectedKeyword;
    }

    /// <summary>
    /// The new file: the source file's usings, its namespace shape (file-scoped or block,
    /// by the namespace's full name) and the moved declaration.
    /// </summary>
    public static CompilationUnitSyntax NewCompilationUnit(
        CompilationUnitSyntax source,
        MoveTypeOutTarget target,
        BaseTypeDeclarationSyntax moved
    )
    {
        var member = moved.WithLeadingTrivia(moved.GetLeadingTrivia().Where(t => !t.IsKind(SyntaxKind.WhitespaceTrivia)));
        var enclosingNamespace = target.Declaration.FirstAncestorOrSelf<BaseNamespaceDeclarationSyntax>();
        var namespaceName = target.Symbol.ContainingNamespace.ToDisplayString();
        MemberDeclarationSyntax top = enclosingNamespace switch
        {
            FileScopedNamespaceDeclarationSyntax => FileScopedNamespaceDeclaration(ParseName(namespaceName))
                .WithUsings(NamespaceUsings(target.Declaration))
                .WithMembers(SingletonList<MemberDeclarationSyntax>(member)),
            NamespaceDeclarationSyntax => NamespaceDeclaration(ParseName(namespaceName))
                .WithUsings(NamespaceUsings(target.Declaration))
                .WithMembers(SingletonList<MemberDeclarationSyntax>(member)),
            _ => member,
        };
        return CompilationUnit()
            .WithUsings(source.Usings)
            .WithMembers(SingletonList(top))
            .WithEndOfFileToken(Token(SyntaxKind.EndOfFileToken));
    }

    /// <summary>The usings of every namespace block around the declaration, outermost first.</summary>
    private static SyntaxList<UsingDirectiveSyntax> NamespaceUsings(SyntaxNode declaration)
    {
        var usings = declaration
            .Ancestors()
            .OfType<BaseNamespaceDeclarationSyntax>()
            .Reverse()
            .SelectMany(ns => ns.Usings);
        return List(usings);
    }
}
