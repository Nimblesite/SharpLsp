using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The attribute at a caret, read by the same tokenizer as the caret's context: the scan up to
/// the caret, continued until the attribute it reads ends. Implements [RAZOR-ARCHITECTURE-HTML]
/// for [RAZOR-COLLOCATION-CSS].
/// </summary>
internal static partial class HtmlMarkupContext
{
    /// <summary>
    /// The attribute the tokenizer reads at <paramref name="offset"/>, from its name to its
    /// value's end: its name, its name's span and its value's span, the quotes excluded. Null
    /// outside a start tag's attribute, and once the tokenizer has left one. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    public static (string Name, TextSpan NameSpan, TextSpan? Value)? AttributeAt(
        string html,
        int offset
    )
    {
        var at = Math.Clamp(offset, 0, html.Length);
        var caret = ScanTo(html, at);
        var scan = Finish(caret, html, at);
        return caret.AttributeStart < 0 || caret.EndTag || !IsReadingAttribute(caret.State)
            ? null
            : (
                html[scan.AttributeStart..scan.NameEnd],
                TextSpan.FromBounds(scan.AttributeStart, scan.NameEnd),
                scan.ValueStart < 0 ? null : TextSpan.FromBounds(scan.ValueStart, scan.ValueEnd)
            );
    }

    /// <summary>Records where the attribute name or value a transition enters or leaves begins or ends.</summary>
    private static Scan Track(Scan before, Scan after, int at)
    {
        return (before.State, after.State) switch
        {
            (not Scanner.Attribute, Scanner.Attribute) => after with
            {
                AttributeStart = at,
                NameEnd = -1,
                ValueStart = -1,
                ValueEnd = -1,
            },
            (Scanner.Attribute, not Scanner.Attribute) => after with { NameEnd = at },
            (Scanner.BeforeValue, Scanner.ValueUnquoted) => after with { ValueStart = at },
            (Scanner.BeforeValue, Scanner.ValueDoubleQuoted or Scanner.ValueSingleQuoted) =>
                after with
                {
                    ValueStart = at + 1,
                },
            (
                Scanner.ValueDoubleQuoted
                    or Scanner.ValueSingleQuoted
                    or Scanner.ValueUnquoted,
                Scanner.AfterValue
                    or Scanner.BeforeAttribute
            ) => after with
            {
                ValueEnd = at,
            },
            _ => after,
        };
    }

    /// <summary>
    /// The scan carried past <paramref name="i"/> until the attribute it reads ends: its tag
    /// closes, the next attribute starts, or the projection ends.
    /// </summary>
    private static Scan Finish(Scan scan, string html, int i)
    {
        while (i < html.Length && IsReadingAttribute(scan.State))
        {
            var (next, j) = Advance(scan, html, i, html.Length);
            if (next.AttributeStart != scan.AttributeStart)
            {
                break;
            }

            (scan, i) = (next, j);
        }

        return Ended(scan, i);
    }

    /// <summary>The scan with the name or value it still reads ending at <paramref name="at"/>.</summary>
    private static Scan Ended(Scan scan, int at)
    {
        return scan with
        {
            NameEnd = scan.NameEnd < 0 ? at : scan.NameEnd,
            ValueEnd = scan.ValueStart >= 0 && scan.ValueEnd < 0 ? at : scan.ValueEnd,
        };
    }

    /// <summary>Whether the tokenizer is inside an attribute, from its name to its value's end.</summary>
    private static bool IsReadingAttribute(Scanner state)
    {
        return state
            is Scanner.Attribute
                or Scanner.AfterAttribute
                or Scanner.BeforeValue
                or Scanner.ValueDoubleQuoted
                or Scanner.ValueSingleQuoted
                or Scanner.ValueUnquoted;
    }
}
