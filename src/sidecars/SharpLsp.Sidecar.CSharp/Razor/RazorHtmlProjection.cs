using Microsoft.AspNetCore.Razor.Language.Intermediate;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Keeps only compiler-owned HTML spans. Everything else starts blank, including Razor
/// comments and C# transitions absent from the IR. Implements [RAZOR-ARCHITECTURE-HTML].
/// </summary>
internal static class RazorHtmlProjection
{
    /// <summary>The projection of <paramref name="root"/>, whose tag helper elements carry <paramref name="prefix"/>.</summary>
    public static string Create(SourceText text, DocumentIntermediateNode root, string prefix)
    {
        var chars = text.ToString().Select(Blank).ToArray();
        Write(root, text, chars, prefix);
        return new string(chars);
    }

    private static void Write(IntermediateNode node, SourceText text, char[] chars, string prefix)
    {
        // A directive attribute's value is never HTML, whatever the compiler holds under it.
        if (node.IsImported || RazorIr.IsDirective(node))
        {
            return;
        }

        WriteNode(node, text, chars, prefix);
        foreach (var child in node.Children)
        {
            Write(child, text, chars, prefix);
        }
    }

    private static void WriteNode(
        IntermediateNode node,
        SourceText text,
        char[] chars,
        string prefix
    )
    {
        if (RazorIr.Tag(node, text, prefix) is { } tag)
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
        foreach (var attribute in RazorIr.NamedAttributes(node, tag, text))
        {
            if (Cleared(attribute) is { } span)
            {
                Clear(chars, span);
            }
        }

        if (tag.EndName is { } end)
        {
            Copy(text, chars, TextSpan.FromBounds(end.Start - 2, tag.Element.End));
        }
    }

    /// <summary>
    /// What an attribute blanks: a directive's whole <c>@name="value"</c>, else its IR span, under
    /// which HTML is copied back as written. A tag helper attribute's name is markup, so a legacy
    /// file's (<c>asp-for</c>, whose span is its value's) stays. [RAZOR-ARCHITECTURE-HTML]
    /// </summary>
    private static TextSpan? Cleared(NamedAttribute attribute)
    {
        return RazorIr.IsDirective(attribute.Node) && attribute is { Name: { } name, End: { } end }
                ? TextSpan.FromBounds(name.Start, end)
            : attribute.Node.Source is { } source
                ? new TextSpan(source.AbsoluteIndex, source.Length)
            : null;
    }

    private static TextSpan[] Attributes(IntermediateNode node)
    {
        return
        [
            .. node
                .Children.Where(RazorIr.IsAttribute)
                .Where(child => child.Source is not null)
                .Select(child => new TextSpan(
                    child.Source!.Value.AbsoluteIndex,
                    child.Source.Value.Length
                )),
        ];
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
