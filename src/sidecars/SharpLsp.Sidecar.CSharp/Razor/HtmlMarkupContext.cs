using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Where the caret sits in projected HTML. Implements [RAZOR-ARCHITECTURE-HTML].
/// </summary>
internal enum MarkupContext
{
    /// <summary>Text between tags, inside comments or declarations, or raw text.</summary>
    Content,

    /// <summary>On a start or end tag's name, or right after <c>&lt;</c>.</summary>
    TagName,

    /// <summary>On an attribute's name, or where a new attribute may start.</summary>
    AttributeName,

    /// <summary>Inside a quoted or unquoted attribute value.</summary>
    AttributeValue,
}

/// <summary>
/// The HTML markup context at a caret: a WHATWG-style tokenizer folded over the projection's
/// prefix up to the caret. Pure — every step maps an immutable state and an input character to
/// the next state. Implements [RAZOR-ARCHITECTURE-HTML].
/// </summary>
internal static partial class HtmlMarkupContext
{
    /// <summary>The markup context at <paramref name="offset"/>; out-of-range offsets clamp.</summary>
    public static MarkupContext At(string html, int offset)
    {
        return Context(ScanTo(html, Math.Clamp(offset, 0, html.Length)));
    }

    /// <summary>
    /// The name of the start tag whose attributes hold <paramref name="offset"/>, lowercased as
    /// the tokenizer reads it; null outside a start tag's attributes. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    public static string? StartTagAt(string html, int offset)
    {
        var scan = ScanTo(html, Math.Clamp(offset, 0, html.Length));
        return Context(scan) == MarkupContext.AttributeName && !scan.EndTag ? scan.Tag : null;
    }

    /// <summary>The tokenizer states the caret context derives from.</summary>
    private enum Scanner
    {
        Data,
        TagOpen,
        EndTagOpen,
        TagName,
        BeforeAttribute,
        Attribute,
        AfterAttribute,
        BeforeValue,
        ValueDoubleQuoted,
        ValueSingleQuoted,
        ValueUnquoted,
        AfterValue,
        SelfClosing,
        RawText,
        ScriptEscaped,
        ScriptDoubleEscaped,
    }

    /// <param name="State">The tokenizer state.</param>
    /// <param name="Tag">The current start tag's name; the raw-text target while in <see cref="Scanner.RawText"/>.</param>
    /// <param name="EndTag">Whether the current tag is an end tag.</param>
    /// <param name="AttributeStart">Where the current attribute's name begins; -1 when no start tag has one.</param>
    /// <param name="NameEnd">Where the current attribute's name ends; -1 while the tokenizer reads it.</param>
    /// <param name="ValueStart">Where the current attribute's value begins, its quote excluded; -1 before it.</param>
    /// <param name="ValueEnd">Where the current attribute's value ends, its quote excluded; -1 while it is read.</param>
    private readonly record struct Scan(
        Scanner State,
        string Tag,
        bool EndTag,
        int AttributeStart = -1,
        int NameEnd = -1,
        int ValueStart = -1,
        int ValueEnd = -1
    );

    private static Scan ScanTo(string html, int end)
    {
        var scan = Data();
        var i = 0;
        while (i < end)
        {
            (scan, i) = Advance(scan, html, i, end);
        }

        return scan;
    }

    private static (Scan Next, int Index) Advance(Scan s, string html, int i, int end)
    {
        var (next, index) = (s.State, html[i]) switch
        {
            (Scanner.TagOpen, '!') => Declaration(html, i),
            (Scanner.TagOpen, '?') => (Data(), Bogus(html, i + 1)),
            (Scanner.EndTagOpen, var c) when c != '>' && !char.IsAsciiLetter(c) => (
                Data(),
                Bogus(html, i)
            ),
            (Scanner.RawText, _) when s.Tag == "script" => Script(s, html, i),
            (Scanner.ScriptEscaped or Scanner.ScriptDoubleEscaped, _) => Script(s, html, i),
            (Scanner.RawText, _) => RawText(s, html, i, end),
            _ => (Step(s, html[i]), i + 1),
        };
        return (Track(s, next, i), index);
    }

    private static Scan Step(Scan s, char c)
    {
        return (s.State, c) switch
        {
            (Scanner.TagOpen, _) => TagOpen(s, c),
            (Scanner.EndTagOpen, _) => EndTagOpen(s, c),
            (Scanner.TagName, _) => TagName(s, c),
            (Scanner.BeforeAttribute or Scanner.SelfClosing, _) => BeforeAttribute(s, c),
            (Scanner.Attribute or Scanner.AfterAttribute, _) => Attribute(s, c),
            (Scanner.BeforeValue, _) => BeforeValue(s, c),
            (Scanner.ValueDoubleQuoted or Scanner.ValueSingleQuoted, _) => Quoted(s, c),
            (Scanner.ValueUnquoted, _) => ValueUnquoted(s, c),
            (Scanner.AfterValue, _) => AfterValue(s, c),
            // Advance handles raw text separately; the remaining state is normal data.
            _ => c == '<' ? Data(Scanner.TagOpen) : s,
        };
    }

    private static Scan Quoted(Scan scan, char value)
    {
        return
            (scan.State, value)
                is
                    (Scanner.ValueDoubleQuoted, '"')
                    or
                    (Scanner.ValueSingleQuoted, '\'')
            ? Kept(Scanner.AfterValue, scan)
            : scan;
    }

    private static Scan TagOpen(Scan s, char c)
    {
        return c switch
        {
            '/' => Data(Scanner.EndTagOpen),
            '<' => Data(Scanner.TagOpen),
            _ => char.IsAsciiLetter(c) ? Named(s, c, false) : Data(),
        };
    }

    private static Scan EndTagOpen(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            _ => char.IsAsciiLetter(c) ? Named(s, c, true) : Data(),
        };
    }

    private static Scan TagName(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            '/' => Kept(Scanner.SelfClosing, s),
            _ => IsSpace(c) ? Kept(Scanner.BeforeAttribute, s) : Named(s, c, s.EndTag),
        };
    }

    private static Scan BeforeAttribute(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            '/' => Kept(Scanner.SelfClosing, s),
            _ => IsSpace(c) ? s : Kept(Scanner.Attribute, s),
        };
    }

    private static Scan Attribute(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            '/' => Kept(Scanner.SelfClosing, s),
            '=' => Kept(Scanner.BeforeValue, s),
            _ => IsSpace(c) ? Kept(Scanner.AfterAttribute, s) : Kept(Scanner.Attribute, s),
        };
    }

    private static Scan BeforeValue(Scan s, char c)
    {
        return c switch
        {
            '"' => Kept(Scanner.ValueDoubleQuoted, s),
            '\'' => Kept(Scanner.ValueSingleQuoted, s),
            '>' => Close(s),
            _ => IsSpace(c) ? s : Kept(Scanner.ValueUnquoted, s),
        };
    }

    private static Scan ValueUnquoted(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            _ => IsSpace(c) ? Kept(Scanner.BeforeAttribute, s) : s,
        };
    }

    private static Scan AfterValue(Scan s, char c)
    {
        return c switch
        {
            '>' => Close(s),
            '/' => Kept(Scanner.SelfClosing, s),
            _ => IsSpace(c) ? Kept(Scanner.BeforeAttribute, s) : Kept(Scanner.Attribute, s),
        };
    }

    /// <summary>A completed start tag of a raw-text element switches to its raw text.</summary>
    private static Scan Close(Scan s)
    {
        return !s.EndTag && IsRawText(s.Tag) ? new Scan(Scanner.RawText, s.Tag, false) : Data();
    }

    /// <summary>
    /// Raw text consumes everything until its appropriate end tag; the <c>&lt;/name</c> then
    /// re-enters the normal tag states ([RAZOR-ARCHITECTURE-HTML]).
    /// </summary>
    private static (Scan Next, int Index) RawText(Scan s, string html, int i, int end)
    {
        if (html[i] != '<')
        {
            return (s, i + 1);
        }

        var close = "</" + s.Tag;
        var j = html.IndexOf(close, i, StringComparison.OrdinalIgnoreCase);
        while (j >= 0 && !EndsTag(html, j + close.Length, html.Length))
        {
            j = html.IndexOf(close, j + 1, StringComparison.OrdinalIgnoreCase);
        }

        return j < 0 ? (s, end) : (Data(), j);
    }

    private static (Scan Next, int Index) Script(Scan s, string html, int i)
    {
        return s switch
        {
            { State: Scanner.RawText } when IsAt(html, i, "<!--") => (
                Kept(Scanner.ScriptEscaped, s),
                i + 4
            ),
            { State: Scanner.ScriptEscaped or Scanner.ScriptDoubleEscaped }
                when IsAt(html, i, "-->") => (Kept(Scanner.RawText, s), i + 3),
            { State: Scanner.ScriptEscaped } when AtTag(html, i, "<script") => (
                Kept(Scanner.ScriptDoubleEscaped, s),
                i + 7
            ),
            _ => ScriptEnd(s, html, i),
        };
    }

    private static (Scan Next, int Index) ScriptEnd(Scan s, string html, int i)
    {
        return !AtTag(html, i, "</script") ? (s, i + 1)
            : s.State == Scanner.ScriptDoubleEscaped ? (Kept(Scanner.ScriptEscaped, s), i + 8)
            : (Data(), i);
    }

    private static bool AtTag(string html, int i, string tag)
    {
        return i + tag.Length <= html.Length
            && html.AsSpan(i, tag.Length).Equals(tag, StringComparison.OrdinalIgnoreCase)
            && EndsTag(html, i + tag.Length, html.Length);
    }

    /// <summary>After <c>&lt;!</c>: comments end at <c>--&gt;</c> or <c>--!&gt;</c>, the rest at <c>&gt;</c>.</summary>
    private static (Scan, int) Declaration(string html, int bang)
    {
        return IsAt(html, bang + 1, "--")
            ? (Data(), SkipComment(html, bang + 3))
            : (
                Data(),
                IsDoctype(html, bang + 1) ? DoctypeEnd(html, bang + 1) : Bogus(html, bang + 1)
            );
    }

    private static bool IsDoctype(string html, int i)
    {
        return html.AsSpan(i).StartsWith("DOCTYPE", StringComparison.OrdinalIgnoreCase);
    }

    private static int DoctypeEnd(string html, int start)
    {
        var quote = '\0';
        for (var i = start; i < html.Length; i++)
        {
            if (quote == '\0' && html[i] == '>')
            {
                return i + 1;
            }

            quote =
                html[i] == quote ? '\0'
                : quote == '\0' && html[i] is '\'' or '"' ? html[i]
                : quote;
        }
        return html.Length;
    }

    private static int SkipComment(string html, int i)
    {
        if (Abrupt(html, i) is { } closed)
        {
            return closed;
        }

        for (var j = i; j < html.Length; j++)
        {
            if (IsAt(html, j, "-->") || IsAt(html, j, "--!>"))
            {
                return j + (html[j + 2] == '!' ? 4 : 3);
            }
        }

        return html.Length;
    }

    // <!--> and <!---> close abruptly ([WHATWG]).
    private static int? Abrupt(string html, int i)
    {
        return IsAt(html, i, ">") ? i + 1
            : IsAt(html, i, "->") ? i + 2
            : null;
    }

    private static int Bogus(string html, int i)
    {
        var close = html.IndexOf('>', i);
        return close < 0 ? html.Length : close + 1;
    }

    private static MarkupContext Context(Scan scan)
    {
        return scan.State is Scanner.TagOpen or Scanner.EndTagOpen or Scanner.TagName
                ? MarkupContext.TagName
            : scan.State
                is Scanner.SelfClosing
                    or Scanner.BeforeAttribute
                    or Scanner.Attribute
                    or Scanner.AfterAttribute
                    or Scanner.AfterValue
                ? MarkupContext.AttributeName
            : ValueContext(scan.State);
    }

    private static MarkupContext ValueContext(Scanner state)
    {
        return
            state
                is Scanner.BeforeValue
                    or Scanner.ValueDoubleQuoted
                    or Scanner.ValueSingleQuoted
                    or Scanner.ValueUnquoted
            ? MarkupContext.AttributeValue
            : MarkupContext.Content;
    }

    private static Scan Data(Scanner state = Scanner.Data)
    {
        return new(state, string.Empty, false);
    }

    private static Scan Kept(Scanner state, Scan s)
    {
        return s with { State = state };
    }

    private static Scan Named(Scan s, char c, bool endTag)
    {
        return new(Scanner.TagName, s.Tag + char.ToLowerInvariant(c), endTag);
    }

    private static bool EndsTag(string html, int k, int end)
    {
        return k >= end || IsSpace(html[k]) || html[k] is '/' or '>';
    }

    /// <summary>HTML's whitespace, which separates a tag's name and attributes.</summary>
    internal static bool IsSpace(char c)
    {
        return c is ' ' or '\t' or '\n' or '\f' or '\r';
    }

    /// <summary>
    /// Where the tag or attribute name that ends at <paramref name="offset"/> begins: back over
    /// the characters a name holds, to whitespace, <c>&lt;</c>, <c>&gt;</c>, <c>/</c>, <c>=</c>
    /// or a quote, as the tokenizer ends a name. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    public static int NameStart(SourceText text, int offset)
    {
        var start = Math.Clamp(offset, 0, text.Length);
        while (start > 0 && IsNameCharacter(text[start - 1]))
        {
            start--;
        }

        return start;
    }

    /// <summary>
    /// Whether the name at <paramref name="start"/> opens its line with Razor's <c>@</c>
    /// transition: only whitespace before it on the line. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    public static bool OpensLineWithTransition(SourceText text, int start)
    {
        var line = text.Lines.GetLineFromPosition(start);
        return start < text.Length
            && text[start] == '@'
            && Enumerable.Range(line.Start, start - line.Start).All(at => IsSpace(text[at]));
    }

    private static bool IsNameCharacter(char c)
    {
        return !IsSpace(c) && c is not ('<' or '>' or '/' or '=' or '"' or '\'');
    }

    private static bool IsAt(string html, int i, string text)
    {
        return i >= 0
            && i + text.Length <= html.Length
            && string.CompareOrdinal(html, i, text, 0, text.Length) == 0;
    }

    // Raw-text and RCDATA elements: markup inside them is text ([RAZOR-ARCHITECTURE-HTML]).
    private static bool IsRawText(string tag)
    {
        return tag
            is "script"
                or "style"
                or "textarea"
                or "title"
                or "xmp"
                or "iframe"
                or "noembed"
                or "noframes";
    }
}
