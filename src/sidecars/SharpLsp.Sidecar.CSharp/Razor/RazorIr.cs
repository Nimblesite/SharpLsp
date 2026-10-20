using Microsoft.AspNetCore.Razor.Language;
using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Facts read from single IR nodes. Every span comes from the compiler; where a node lacks
/// one (an end tag's name, a directive's name) it is derived from the node's span and then
/// verified against the text, so a span the compiler did not shape that way is never
/// reported. Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal static partial class RazorIr
{
    /// <summary>Every node under <paramref name="root"/>, parents before children.</summary>
    public static IEnumerable<IntermediateNode> Descendants(IntermediateNode root)
    {
        var pending = new Stack<IntermediateNode>([root]);
        while (pending.TryPop(out var node))
        {
            yield return node;
            foreach (var child in node.Children.Reverse())
            {
                pending.Push(child);
            }
        }
    }

    /// <summary>
    /// The spans of the C# code blocks (<c>@{ … }</c>) under <paramref name="root"/>: C# code
    /// outside every directive, whose own blocks (<c>@code</c>) fold as directives.
    /// </summary>
    public static IEnumerable<TextSpan> CodeBlocks(IntermediateNode root)
    {
        var pending = new Stack<IntermediateNode>([root]);
        while (pending.TryPop(out var node))
        {
            if (node is DirectiveIntermediateNode || node.IsImported)
            {
                continue;
            }

            if (node is CSharpCodeIntermediateNode { Source: { } source })
            {
                yield return Span(source);
            }

            foreach (var child in node.Children)
            {
                pending.Push(child);
            }
        }
    }

    /// <summary>The directive a node declares: a <c>DirectiveIntermediateNode</c> or an <c>@using</c>.</summary>
    public static MarkupDirective? Directive(IntermediateNode node, SourceText text)
    {
        return node switch
        {
            DirectiveIntermediateNode { Source: { } source } directive => Named(
                directive.DirectiveName,
                Span(source),
                1,
                directive.Directive,
                text
            ),
            UsingDirectiveIntermediateNode { Source: { } source } => Named(
                "using",
                Span(source),
                0,
                null,
                text
            ),
            _ => null,
        };
    }

    /// <summary>The tag helper directives under <paramref name="root"/>, its imports' first, in order.</summary>
    public static IEnumerable<TagHelperDirective> TagHelperDirectives(IntermediateNode root)
    {
        return Descendants(root)
            .OfType<DirectiveIntermediateNode>()
            .Where(directive => RazorTagHelperScope.Declares(directive.DirectiveName))
            .Select(directive => new TagHelperDirective(
                directive.DirectiveName,
                directive
                    .Children.OfType<DirectiveTokenIntermediateNode>()
                    .FirstOrDefault()
                    ?.Content
                    ?? ""
            ));
    }

    /// <summary>The namespace an <c>@using</c> imports, without a <c>global::</c> qualifier; null for an alias or static using.</summary>
    public static string? Namespace(UsingDirectiveIntermediateNode use)
    {
        var name = SyntaxFactory.ParseName(use.Content ?? "");
        if (name.ContainsDiagnostics || name.FullSpan.Length != (use.Content ?? "").Length)
        {
            return null;
        }

        var global = name.DescendantNodesAndSelf()
            .OfType<AliasQualifiedNameSyntax>()
            .FirstOrDefault();
        return (global is null ? name : name.ReplaceNode(global, global.Name)).ToString();
    }

    /// <summary>
    /// The tag a node is: an element bound to tag helpers, or a plain component-file element.
    /// A legacy file's tag helper element is spelled with the file's <c>@tagHelperPrefix</c>.
    /// </summary>
    public static MarkupTag? Tag(IntermediateNode node, SourceText text, string prefix)
    {
        return node switch
        {
            TagHelperIntermediateNode { Source: { } source } bound => BoundTag(
                bound,
                Span(source),
                text,
                prefix
            ),
            MarkupElementIntermediateNode { Source: { } source } element => PlainTag(
                element.TagName,
                Span(source),
                text
            ),
            _ => null,
        };
    }

    /// <summary>Whether a diagnostic belongs to the processed file, not to one of its imports.</summary>
    public static bool IsIn(RazorDiagnostic diagnostic, string? path, SourceText text)
    {
        var span = diagnostic.Span;
        return span.AbsoluteIndex >= 0
            && span.AbsoluteIndex + span.Length <= text.Length
            && (string.IsNullOrEmpty(span.FilePath) || NativePaths.AreEqual(span.FilePath, path));
    }

    /// <summary>
    /// An element tag helpers bind. A component's IR carries its start tag name's span; a
    /// legacy file's does not, so its name, prefix first, is read just after the element's
    /// <c>&lt;</c>, as HTML spells it in any case, and only where the text holds it.
    /// </summary>
    private static MarkupTag? BoundTag(
        TagHelperIntermediateNode bound,
        TextSpan element,
        SourceText text,
        string prefix
    )
    {
        var legacy = bound.StartTagSpan is null;
        var comparison = legacy ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var spelled = legacy ? prefix + bound.TagName : bound.TagName;
        var start = bound.StartTagSpan is { } span
            ? Span(span)
            : new TextSpan(element.Start + 1, spelled.Length);
        return Holds(text, start, spelled, comparison)
            ? new MarkupTag(
                bound.TagName,
                element,
                start,
                bound.TagMode == TagMode.StartTagAndEndTag
                    ? EndName(element, spelled, text, comparison)
                    : null,
                [.. bound.TagHelpers]
            )
            : null;
    }

    private static MarkupTag? PlainTag(string name, TextSpan element, SourceText text)
    {
        var start = new TextSpan(element.Start + 1, name.Length);
        return Holds(text, start, name)
            ? new MarkupTag(
                name,
                element,
                start,
                EndName(element, name, text, StringComparison.OrdinalIgnoreCase),
                []
            )
            : null;
    }

    /// <summary>A directive attribute's name, <c>@</c> included, from the span of what follows the <c>@</c>.</summary>
    public static TextSpan? DirectiveName(SourceSpan? original, string name, SourceText text)
    {
        if (original is not { } span)
        {
            return null;
        }

        var withTransition = new TextSpan(span.AbsoluteIndex - 1, name.Length);
        return withTransition.Start >= 0 && Holds(text, withTransition, name)
            ? withTransition
            : Span(span);
    }

    /// <summary>The span of <paramref name="name"/> at the first non-space offset from <paramref name="start"/>, when the text holds it there.</summary>
    public static TextSpan? NameAfter(SourceText text, int start, string name)
    {
        var at = start;
        while (at < text.Length && HtmlMarkupContext.IsSpace(text[at]))
        {
            at++;
        }

        var span = new TextSpan(at, name.Length);
        return Holds(text, span, name) ? span : null;
    }

    /// <summary>The name of an element's end tag, <c>&lt;/Name&gt;</c> closing <paramref name="element"/>.</summary>
    private static TextSpan? EndName(
        TextSpan element,
        string name,
        SourceText text,
        StringComparison comparison = StringComparison.Ordinal
    )
    {
        var nameEnd = element.End - 1;
        while (nameEnd > element.Start && HtmlMarkupContext.IsSpace(text[nameEnd - 1]))
        {
            nameEnd--;
        }
        var end = new TextSpan(nameEnd - name.Length, name.Length);
        return
            end.Start >= element.Start + 2
            && Holds(text, new TextSpan(end.Start - 2, 2), "</")
            && Holds(text, end, name, comparison)
            && Holds(text, new TextSpan(element.End - 1, 1), ">")
            ? end
            : null;
    }

    private static MarkupDirective? Named(
        string name,
        TextSpan span,
        int nameOffset,
        DirectiveDescriptor? descriptor,
        SourceText text
    )
    {
        var nameSpan = new TextSpan(span.Start + nameOffset, name.Length);
        return Holds(text, nameSpan, name)
            ? new MarkupDirective(name, span, nameSpan, descriptor)
            : null;
    }

    private static bool Holds(
        SourceText text,
        TextSpan span,
        string expected,
        StringComparison comparison = StringComparison.Ordinal
    )
    {
        return span.End <= text.Length && string.Equals(text.ToString(span), expected, comparison);
    }

    private static TextSpan Span(SourceSpan span)
    {
        return new TextSpan(span.AbsoluteIndex, span.Length);
    }
}
