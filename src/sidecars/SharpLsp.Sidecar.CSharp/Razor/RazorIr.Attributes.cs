using Microsoft.AspNetCore.Razor.Language;
using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>A tag's attribute node, with its name's span and its end where the compiler's spans and the text say.</summary>
internal readonly record struct NamedAttribute(IntermediateNode Node, TextSpan? Name, int? End);

/// <summary>
/// Attribute facts read from a tag's IR nodes, in source order. Implements
/// [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal static partial class RazorIr
{
    /// <summary>The attributes of a tag node, each with what binds it.</summary>
    public static IEnumerable<MarkupAttribute> Attributes(
        IntermediateNode node,
        MarkupTag tag,
        SourceText text
    )
    {
        return NamedAttributes(node, tag, text)
            .Select(named =>
                Bound(named.Node) is { } bound
                    ? new MarkupAttribute(
                        bound.Kind,
                        bound.Name,
                        named.Name,
                        tag,
                        bound.TagHelper,
                        bound.Attribute,
                        bound.Parameter
                    )
                    : null
            )
            .OfType<MarkupAttribute>();
    }

    /// <summary>
    /// A tag node's attributes, each with its name's span and its end. A name the compiler gives
    /// no span (a legacy file's attribute, a minimized directive parameter) is read where the
    /// attribute before it ends, and only where the text holds it. The nodes that several tag
    /// helpers bind for one attribute share its value, and so its name.
    /// </summary>
    public static IEnumerable<NamedAttribute> NamedAttributes(
        IntermediateNode node,
        MarkupTag tag,
        SourceText text
    )
    {
        int? after = tag.StartName.End;
        var from = after;
        IntermediateNode? previous = null;
        foreach (var child in node.Children.Where(IsAttribute))
        {
            from = previous is not null && SameAttribute(previous, child) ? from : after;
            var name = NameOf(child, text, from);
            var end = EndOf(child, name);
            yield return new NamedAttribute(child, name, end);
            (after, previous) = (end, child);
        }
    }

    /// <summary>Whether a node is one of a tag's attributes.</summary>
    public static bool IsAttribute(IntermediateNode node)
    {
        return node
                is HtmlAttributeIntermediateNode
                    or TagHelperHtmlAttributeIntermediateNode
                    or TagHelperPropertyIntermediateNode
            || IsDirective(node);
    }

    /// <summary>Whether a node is a directive attribute (<c>@onclick</c>) or one of its parameters.</summary>
    public static bool IsDirective(IntermediateNode node)
    {
        return node
            is TagHelperDirectiveAttributeIntermediateNode
                or TagHelperDirectiveAttributeParameterIntermediateNode;
    }

    /// <summary>What an attribute node is to the compiler, by the name it was written with.</summary>
    private static (
        MarkupAttributeKind Kind,
        string Name,
        TagHelperDescriptor? TagHelper,
        BoundAttributeDescriptor? Attribute,
        BoundAttributeParameterDescriptor? Parameter
    )? Bound(IntermediateNode node)
    {
        return node switch
        {
            TagHelperPropertyIntermediateNode property => (
                MarkupAttributeKind.Property,
                property.AttributeName,
                property.TagHelper,
                property.BoundAttribute,
                null
            ),
            TagHelperDirectiveAttributeIntermediateNode directive => (
                MarkupAttributeKind.Directive,
                directive.OriginalAttributeName,
                directive.TagHelper,
                directive.BoundAttribute,
                null
            ),
            TagHelperDirectiveAttributeParameterIntermediateNode parameter => (
                MarkupAttributeKind.DirectiveParameter,
                parameter.OriginalAttributeName,
                parameter.TagHelper,
                parameter.BoundAttribute,
                parameter.BoundAttributeParameter
            ),
            TagHelperHtmlAttributeIntermediateNode html => Html(html.AttributeName),
            HtmlAttributeIntermediateNode html => Html(html.AttributeName),
            _ => null,
        };
    }

    private static (
        MarkupAttributeKind,
        string,
        TagHelperDescriptor?,
        BoundAttributeDescriptor?,
        BoundAttributeParameterDescriptor?
    ) Html(string name)
    {
        return (MarkupAttributeKind.Html, name, null, null, null);
    }

    /// <summary>An attribute's name: the compiler's span, else read where the attribute starts.</summary>
    private static TextSpan? NameOf(IntermediateNode node, SourceText text, int? from)
    {
        return node switch
        {
            TagHelperDirectiveAttributeIntermediateNode directive => Located(
                directive.OriginalAttributeSpan,
                directive.OriginalAttributeName,
                directive.AttributeStructure,
                text,
                from
            ),
            TagHelperDirectiveAttributeParameterIntermediateNode parameter => Located(
                parameter.OriginalAttributeSpan,
                parameter.OriginalAttributeName,
                parameter.AttributeStructure,
                text,
                from
            ),
            TagHelperPropertyIntermediateNode { OriginalAttributeSpan: { } span } => Span(span),
            _ => Bound(node) is { } bound && from is { } start
                ? NameAfter(text, start, bound.Name)
                : null,
        };
    }

    /// <summary>
    /// A directive attribute's name from the compiler's span. The compiler gives a minimized
    /// directive parameter (<c>@onclick:stopPropagation</c>) no span, so its name is read where
    /// the attribute before it ends.
    /// </summary>
    private static TextSpan? Located(
        SourceSpan? original,
        string name,
        AttributeStructure structure,
        SourceText text,
        int? from
    )
    {
        return original is null && structure == AttributeStructure.Minimized && from is { } start
            ? NameAfter(text, start, name)
            : DirectiveName(original, name, text);
    }

    /// <summary>
    /// Where an attribute ends: its value's end and closing quote, else, for a directive or a
    /// minimized attribute, its name's end; null when neither the IR nor the text says.
    /// </summary>
    private static int? EndOf(IntermediateNode node, TextSpan? name)
    {
        var structure = Structure(node);
        var value =
            LastEnd(node)
            ?? (IsDirective(node) || structure == AttributeStructure.Minimized ? name?.End : null);
        return value is { } found ? Closing(structure, found) : null;
    }

    /// <summary>Whether two property nodes are one attribute that two tag helpers bind.</summary>
    private static bool SameAttribute(IntermediateNode first, IntermediateNode second)
    {
        return first is TagHelperPropertyIntermediateNode { Source: { } value } one
            && second is TagHelperPropertyIntermediateNode { Source: { } other } two
            && one.AttributeName == two.AttributeName
            && value.Equals(other);
    }

    /// <summary>The end of an attribute's last IR span, its own or a value's under it.</summary>
    private static int? LastEnd(IntermediateNode node)
    {
        var ends = Descendants(node)
            .Select(child => child.Source)
            .OfType<SourceSpan>()
            .Select(source => source.AbsoluteIndex + source.Length)
            .ToArray();
        return ends.Length > 0 ? ends.Max() : null;
    }

    /// <summary>How the compiler read a bound attribute's value; a plain attribute's span holds its quotes.</summary>
    private static AttributeStructure Structure(IntermediateNode node)
    {
        return node switch
        {
            TagHelperHtmlAttributeIntermediateNode html => html.AttributeStructure,
            TagHelperPropertyIntermediateNode property => property.AttributeStructure,
            TagHelperDirectiveAttributeIntermediateNode directive => directive.AttributeStructure,
            TagHelperDirectiveAttributeParameterIntermediateNode parameter =>
                parameter.AttributeStructure,
            _ => AttributeStructure.Minimized,
        };
    }

    /// <summary>An attribute's end: its value's end, plus the closing quote the compiler parsed.</summary>
    private static int Closing(AttributeStructure structure, int valueEnd)
    {
        return structure is AttributeStructure.DoubleQuotes or AttributeStructure.SingleQuotes
            ? valueEnd + 1
            : valueEnd;
    }
}
