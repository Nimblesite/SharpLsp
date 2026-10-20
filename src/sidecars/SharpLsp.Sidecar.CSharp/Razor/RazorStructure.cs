using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>One outline entry before nesting: what it is, where it is, and where its name is.</summary>
internal readonly record struct RazorOutline(
    string Name,
    string Kind,
    TextSpan Span,
    TextSpan NameSpan
);

/// <summary>
/// The structure of a Razor file — folding ranges, the document outline and linked tag
/// names — read from its markup facts and its projection. Implements
/// [RAZOR-FEATURES-STRUCTURE].
/// </summary>
internal static class RazorStructure
{
    /// <summary>Every element and directive that spans lines folds, keeping its last line visible.</summary>
    public static List<FoldingRangeResult> Folds(RazorMarkup markup)
    {
        var lines = markup.Text.Lines;
        return
        [
            .. markup
                .Tags.Select(tag => tag.Element)
                .Concat(markup.Directives.Select(directive => directive.Span))
                .Select(lines.GetLinePositionSpan)
                .Where(span => span.End.Line - 1 > span.Start.Line)
                .Select(span => (Start: span.Start.Line, End: span.End.Line - 1))
                .Distinct()
                .Order()
                .Select(fold => new FoldingRangeResult
                {
                    StartLine = fold.Start,
                    EndLine = fold.End,
                }),
        ];
    }

    /// <summary>The start and end tag names of the element named at <paramref name="offset"/>, edited together.</summary>
    public static IEnumerable<TextSpan> LinkedNames(RazorMarkup markup, int offset)
    {
        return markup.TagNamedAt(offset) is { EndName: { } end } tag ? [tag.StartName, end] : [];
    }

    /// <summary>
    /// The outline: directives, elements bound to components or tag helpers, and the members
    /// the file declares, each nested in the innermost entry that holds it.
    /// </summary>
    public static List<DocumentSymbolResult> Symbols(
        RazorMarkup markup,
        IEnumerable<RazorOutline> members
    )
    {
        var directives = markup.Directives.Select(directive => new RazorOutline(
            "@" + directive.Name,
            "Key",
            directive.Span,
            directive.NameSpan
        ));
        var tags = markup
            .Tags.Where(tag => !tag.TagHelpers.IsEmpty)
            .Select(tag => new RazorOutline(tag.Name, "Class", tag.Element, tag.StartName));
        return Nest(directives.Concat(tags).Concat(members), markup.Text);
    }

    /// <summary>The members <paramref name="projection"/> declares inside its Razor file: <c>@code</c> methods, properties and fields, and <c>@inject</c> properties.</summary>
    public static IEnumerable<RazorOutline> Members(RazorProjection projection)
    {
        return projection
            .GeneratedRoot.DescendantNodes()
            .Select(Member)
            .OfType<(SyntaxToken Name, string Kind, SyntaxNode Node)>()
            .Select(member => Outline(projection.Map, member))
            .OfType<RazorOutline>();
    }

    private static (SyntaxToken Name, string Kind, SyntaxNode Node)? Member(SyntaxNode node)
    {
        return node switch
        {
            MethodDeclarationSyntax method => (method.Identifier, "Method", method),
            PropertyDeclarationSyntax property => (property.Identifier, "Property", property),
            VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax field } variable => (
                variable.Identifier,
                "Field",
                field
            ),
            _ => null,
        };
    }

    private static RazorOutline? Outline(
        RazorSpanMap map,
        (SyntaxToken Name, string Kind, SyntaxNode Node) member
    )
    {
        return map.ToRazor(member.Name.Span) is { } name
            ? new RazorOutline(
                member.Name.ValueText,
                member.Kind,
                map.ToRazor(member.Node.Span) ?? name,
                name
            )
            : null;
    }

    private static List<DocumentSymbolResult> Nest(IEnumerable<RazorOutline> items, SourceText text)
    {
        var roots = new List<DocumentSymbolResult>();
        var open = new Stack<(TextSpan Span, DocumentSymbolResult Symbol)>();
        foreach (
            var item in items
                .OrderBy(item => item.Span.Start)
                .ThenByDescending(item => item.Span.Length)
        )
        {
            while (open.TryPeek(out var top) && !top.Span.Contains(item.Span))
            {
                _ = open.Pop();
            }

            var symbol = ToResult(item, text.Lines);
            (open.TryPeek(out var parent) ? parent.Symbol.Children : roots).Add(symbol);
            open.Push((item.Span, symbol));
        }

        return roots;
    }

    private static DocumentSymbolResult ToResult(RazorOutline item, TextLineCollection lines)
    {
        var span = lines.GetLinePositionSpan(item.Span);
        var name = lines.GetLinePositionSpan(item.NameSpan);
        return new DocumentSymbolResult
        {
            Name = item.Name,
            Kind = item.Kind,
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character,
            SelectionStartLine = name.Start.Line,
            SelectionStartCharacter = name.Start.Character,
            SelectionEndLine = name.End.Line,
            SelectionEndCharacter = name.End.Character,
        };
    }
}
