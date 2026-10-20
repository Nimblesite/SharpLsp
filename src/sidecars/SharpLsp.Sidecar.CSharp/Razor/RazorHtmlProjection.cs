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
        if (node.IsImported)
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
        foreach (var attribute in attributes)
        {
            Clear(chars, attribute);
        }

        if (tag.EndName is { } end)
        {
            Copy(text, chars, TextSpan.FromBounds(end.Start - 2, tag.Element.End));
        }
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
                or TagHelperDirectiveAttributeIntermediateNode
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
