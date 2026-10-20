using Microsoft.AspNetCore.Razor.Language;
using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Keeps only compiler-owned HTML spans. Everything else starts blank, including Razor
/// comments and C# transitions absent from the IR. Implements [RAZOR-ARCHITECTURE-HTML].
/// </summary>
internal static class RazorHtmlProjection
{
    public static string Create(SourceText text, DocumentIntermediateNode root)
    {
        var chars = text.ToString().Select(Blank).ToArray();
        Write(root, text, chars);
        return new string(chars);
    }

    private static void Write(IntermediateNode node, SourceText text, char[] chars)
    {
        // A directive attribute's value is never HTML, whatever the compiler holds under it.
        if (node.IsImported || IsDirective(node))
        {
            return;
        }

        WriteNode(node, text, chars);
        foreach (var child in node.Children)
        {
            Write(child, text, chars);
        }
    }

    private static void WriteNode(IntermediateNode node, SourceText text, char[] chars)
    {
        if (RazorIr.Tag(node, text) is { } tag)
        {
            WriteTag(node, tag, text, chars);
        }
        else
        {
            WriteLiteral(node, text, chars);
        }
    }

    private static void WriteLiteral(IntermediateNode node, SourceText text, char[] chars)
    {
        if (node.Source is not { } source)
        {
            return;
        }

        var span = new TextSpan(source.AbsoluteIndex, source.Length);
        if (node is HtmlIntermediateToken or HtmlAttributeValueIntermediateNode)
        {
            Copy(text, chars, span);
        }
        else if (node is HtmlAttributeIntermediateNode attribute)
        {
            CopyAttribute(text, chars, span, attribute);
        }
        else if (
            node
            is CSharpExpressionAttributeValueIntermediateNode
                or CSharpCodeAttributeValueIntermediateNode
        )
        {
            Clear(chars, span);
        }
    }

    private static void CopyAttribute(
        SourceText text,
        char[] chars,
        TextSpan span,
        HtmlAttributeIntermediateNode attribute
    )
    {
        var prefixLength = attribute.Prefix?.Length ?? 0;
        var suffixLength = attribute.Suffix?.Length ?? 0;
        Copy(text, chars, new TextSpan(span.Start, prefixLength));
        Copy(text, chars, new TextSpan(span.End - suffixLength, suffixLength));
    }

    private static void WriteTag(
        IntermediateNode node,
        MarkupTag tag,
        SourceText text,
        char[] chars
    )
    {
        var attributes = Attributes(node);
        Copy(
            text,
            chars,
            TextSpan.FromBounds(tag.Element.Start, OpeningEnd(text, tag.Element, attributes))
        );
        // The IR lists attributes in source order, so each one starts after the one before it.
        int? after = tag.StartName.End;
        foreach (var attribute in node.Children.Where(IsAttribute))
        {
            after = ClearAttribute(chars, text, attribute, after);
        }

        if (tag.EndName is { } end)
        {
            Copy(text, chars, TextSpan.FromBounds(end.Start - 2, tag.Element.End));
        }
    }

    /// <summary>
    /// Blanks an attribute's IR span and a directive's whole <c>@name="value"</c>, and answers
    /// where the attribute ends, or null when the IR does not say.
    /// </summary>
    private static int? ClearAttribute(
        char[] chars,
        SourceText text,
        IntermediateNode node,
        int? after
    )
    {
        var last = LastEnd(node);
        if (DirectiveName(node, text, after) is { } name)
        {
            var end = Closing(Structure(node), last ?? name.End);
            Clear(chars, TextSpan.FromBounds(name.Start, end));
            return end;
        }

        if (node.Source is { } source)
        {
            Clear(chars, new TextSpan(source.AbsoluteIndex, source.Length));
        }

        return last is { } found
            ? Closing(Structure(node), found)
            : MinimizedEnd(node, text, after);
    }

    /// <summary>A directive attribute's name, its <c>@</c> included.</summary>
    private static TextSpan? DirectiveName(IntermediateNode node, SourceText text, int? after)
    {
        return node switch
        {
            TagHelperDirectiveAttributeIntermediateNode directive => Located(
                directive.OriginalAttributeSpan,
                directive.OriginalAttributeName,
                directive.AttributeStructure,
                text,
                after
            ),
            TagHelperDirectiveAttributeParameterIntermediateNode parameter => Located(
                parameter.OriginalAttributeSpan,
                parameter.OriginalAttributeName,
                parameter.AttributeStructure,
                text,
                after
            ),
            _ => null,
        };
    }

    /// <summary>
    /// A directive attribute's name from the compiler's span. The compiler gives a minimized
    /// directive parameter (<c>@onclick:stopPropagation</c>) no span, so its name is read where
    /// the attribute before it ends, and only when the text there holds it.
    /// </summary>
    private static TextSpan? Located(
        SourceSpan? original,
        string name,
        AttributeStructure structure,
        SourceText text,
        int? after
    )
    {
        return original is null && structure == AttributeStructure.Minimized && after is { } start
            ? RazorIr.NameAfter(text, start, name)
            : RazorIr.DirectiveName(original, name, text);
    }

    /// <summary>The end of an attribute's last IR span, its own or a value's under it.</summary>
    private static int? LastEnd(IntermediateNode node)
    {
        var ends = RazorIr
            .Descendants(node)
            .Select(child => child.Source)
            .OfType<SourceSpan>()
            .Select(source => source.AbsoluteIndex + source.Length)
            .ToArray();
        return ends.Length > 0 ? ends.Max() : null;
    }

    /// <summary>A minimized attribute has no span, so it ends after its name, read where the one before it ends.</summary>
    private static int? MinimizedEnd(IntermediateNode node, SourceText text, int? after)
    {
        return
            node is TagHelperHtmlAttributeIntermediateNode html
            && html.AttributeStructure == AttributeStructure.Minimized
            && after is { } start
            ? RazorIr.NameAfter(text, start, html.AttributeName)?.End
            : null;
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

    private static TextSpan[] Attributes(IntermediateNode node)
    {
        return
        [
            .. node
                .Children.Where(IsAttribute)
                .Where(child => child.Source is not null)
                .Select(child => new TextSpan(
                    child.Source!.Value.AbsoluteIndex,
                    child.Source.Value.Length
                )),
        ];
    }

    private static bool IsAttribute(IntermediateNode node)
    {
        return node
                is HtmlAttributeIntermediateNode
                    or TagHelperHtmlAttributeIntermediateNode
                    or TagHelperPropertyIntermediateNode
            || IsDirective(node);
    }

    private static bool IsDirective(IntermediateNode node)
    {
        return node
            is TagHelperDirectiveAttributeIntermediateNode
                or TagHelperDirectiveAttributeParameterIntermediateNode;
    }

    /// <summary>Tokenizes only an IR-owned opening tag; compiler attribute spans are opaque.</summary>
    private static int OpeningEnd(SourceText text, TextSpan element, TextSpan[] attributes)
    {
        var quote = '\0';
        foreach (
            var offset in Enumerable
                .Range(element.Start, element.Length)
                .Where(index => !attributes.Any(span => span.Contains(index)))
        )
        {
            var character = text[offset];
            if (quote == '\0' && character == '>')
            {
                return offset + 1;
            }

            quote =
                character == quote ? '\0'
                : quote == '\0' && character is '\'' or '"' ? character
                : quote;
        }

        return element.End;
    }

    private static void Copy(SourceText text, char[] chars, TextSpan span)
    {
        if (span.End <= text.Length)
        {
            text.CopyTo(span.Start, chars, span.Start, span.Length);
        }
    }

    private static void Clear(char[] chars, TextSpan span)
    {
        for (var offset = span.Start; offset < span.End && offset < chars.Length; offset++)
        {
            chars[offset] = Blank(chars[offset]);
        }
    }

    private static char Blank(char character)
    {
        return character is '\r' or '\n' ? character : ' ';
    }
}
