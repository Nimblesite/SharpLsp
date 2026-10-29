using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>
/// A name the compiler could not resolve, with the diagnostic that reports it and the syntax
/// that spells it. Implements the triggers of [REFACTOR-IMPORT].
/// </summary>
internal sealed record ImportSubject(Diagnostic Diagnostic, SimpleNameSyntax Name)
{
    private static readonly ImmutableHashSet<string> Triggers =
    [
        "CS0246",
        "CS0103",
        "CS0234",
        "CS0616",
        "CS1061",
    ];

    /// <summary>The name as an identifier, without type arguments.</summary>
    public string Text => Name.Identifier.ValueText;

    /// <summary>The number of type arguments the name is written with.</summary>
    public int Arity =>
        Name is GenericNameSyntax generic ? generic.TypeArgumentList.Arguments.Count : 0;

    /// <summary>Every unresolved name a trigger diagnostic reports within <paramref name="span"/>.</summary>
    public static async Task<ImmutableArray<ImportSubject>> FindAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return model is null || root is null
            ? []
            :
            [
                .. model
                    .GetDiagnostics(span, ct)
                    .Where(diagnostic => Triggers.Contains(diagnostic.Id))
                    .Select(diagnostic => Of(root, diagnostic))
                    .OfType<ImportSubject>(),
            ];
    }

    private static ImportSubject? Of(SyntaxNode root, Diagnostic diagnostic)
    {
        var node = root.FindNode(diagnostic.Location.SourceSpan, getInnermostNodeForTie: true);
        return NameIn(node) is { } name ? new ImportSubject(diagnostic, name) : null;
    }

    private static SimpleNameSyntax? NameIn(SyntaxNode node)
    {
        return node switch
        {
            SimpleNameSyntax simple => simple,
            QualifiedNameSyntax qualified => qualified.Right,
            MemberAccessExpressionSyntax access => access.Name,
            _ => node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().FirstOrDefault(),
        };
    }
}
