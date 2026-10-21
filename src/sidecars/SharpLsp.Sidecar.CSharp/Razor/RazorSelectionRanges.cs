using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The selection ranges of a Razor file: each position answers the chain from its innermost
/// span — the C# fragment's token and enclosing syntax nodes, then the markup facts' attribute,
/// tag name, elements, directives and code blocks — out to the whole document. A candidate
/// that cannot map back to the Razor file as a whole, that does not hold the chain so far, or
/// that duplicates it, is dropped, never approximated. Implements [RAZOR-FEATURES-SELECTION].
/// </summary>
internal static class RazorSelectionRanges
{
    /// <summary>The spans holding <paramref name="offset"/>, innermost first, in Razor offsets.</summary>
    public static IEnumerable<TextSpan> At(
        RazorProjection? projection,
        RazorMarkup? markup,
        int offset
    )
    {
        return Nested(
            Fragment(projection, offset)
                .Concat(Markup(markup, offset))
                .Append(Document(projection, markup)),
            offset
        );
    }

    /// <summary>
    /// The C# fragment at <paramref name="offset"/>: the Roslyn token there, then each
    /// enclosing node of the projection's syntax tree, keeping only the spans that map back
    /// to the Razor file whole. [RAZOR-ARCHITECTURE-PROJECTION]
    /// </summary>
    private static IEnumerable<TextSpan> Fragment(RazorProjection? projection, int offset)
    {
        return projection is not { } found || found.Map.ToGenerated(offset) is not { } generated
            ? []
            : NodeSpans(found.GeneratedRoot.FindToken(generated), generated)
                .Select(found.Map.ToRazor)
                .OfType<TextSpan>();
    }

    /// <summary>The token's span when it holds the position, then every enclosing node's span.</summary>
    private static IEnumerable<TextSpan> NodeSpans(SyntaxToken token, int generated)
    {
        var nodes = token.Parent?.AncestorsAndSelf().Select(node => node.Span) ?? [];
        return token.Span.Contains(generated) ? new[] { token.Span }.Concat(nodes) : nodes;
    }

    /// <summary>
    /// The markup facts' spans holding <paramref name="offset"/>: an attribute, a tag name,
    /// every enclosing element, directives and C# code blocks. [RAZOR-ARCHITECTURE-ENGINE-FACTS]
    /// </summary>
    private static IEnumerable<TextSpan> Markup(RazorMarkup? markup, int offset)
    {
        return markup is not { } facts
            ? []
            : Attribute(facts, offset)
                .Concat(TagName(facts, offset))
                .Concat(
                    facts
                        .Tags.Where(tag => tag.Element.Contains(offset))
                        .OrderBy(tag => tag.Element.Length)
                        .Select(tag => tag.Element)
                )
                .Concat(
                    facts
                        .Directives.Where(directive => directive.Span.Contains(offset))
                        .Select(directive => directive.Span)
                )
                .Concat(facts.CodeBlocks.Where(block => block.Contains(offset)));
    }

    /// <summary>
    /// The attribute whose name or value holds <paramref name="offset"/>: its name's span,
    /// then the whole attribute when it reaches past the name.
    /// </summary>
    private static IEnumerable<TextSpan> Attribute(RazorMarkup facts, int offset)
    {
        var found = facts
            .Attributes.Select(attribute => (attribute.NameSpan, Whole: Whole(attribute)))
            .FirstOrDefault(pair => pair.Whole is { } whole && whole.Contains(offset));
        return found.NameSpan is not { } name ? []
            : found.Whole is { } whole && whole != name ? [name, whole]
            : [name];
    }

    /// <summary>
    /// The attribute's whole span, from its name's start to the end the compiler's spans give
    /// it; an attribute they give no end is its name.
    /// </summary>
    private static TextSpan? Whole(MarkupAttribute attribute)
    {
        return attribute.NameSpan is not { } name ? null
            : attribute.End is { } end && end > name.End ? TextSpan.FromBounds(name.Start, end)
            : name;
    }

    /// <summary>The start or end tag name holding <paramref name="offset"/>, when one does.</summary>
    private static IEnumerable<TextSpan> TagName(RazorMarkup facts, int offset)
    {
        return facts.TagNamedAt(offset) is { } tag ? [tag.NameAt(offset)] : [];
    }

    /// <summary>The whole file's span, from the facts' or the projection's text.</summary>
    private static TextSpan Document(RazorProjection? projection, RazorMarkup? markup)
    {
        return new TextSpan(0, (markup?.Text ?? projection?.RazorText)?.Length ?? 0);
    }

    /// <summary>
    /// The candidates that hold <paramref name="offset"/> and hold every span kept before
    /// them, innermost first: one that does not contain the chain so far, or that duplicates
    /// it, drops out.
    /// </summary>
    private static ImmutableList<TextSpan> Nested(IEnumerable<TextSpan> candidates, int offset)
    {
        return candidates.Aggregate(
            ImmutableList<TextSpan>.Empty,
            (chain, candidate) =>
                chain.Count == 0 && !candidate.Contains(offset) ? chain
                : chain.Count > 0 && !StrictlyHolds(chain[^1], candidate) ? chain
                : chain.Add(candidate)
        );
    }

    /// <summary>Whether <paramref name="outer"/> contains <paramref name="inner"/> with room to spare.</summary>
    private static bool StrictlyHolds(TextSpan inner, TextSpan outer)
    {
        return outer.Contains(inner) && outer != inner;
    }
}
