using System.Text;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>The kinds of token the CSS Syntax Module Level 3 algorithm produces.</summary>
internal enum CssTokenKind
{
    /// <summary>A name: an element, a class after its <c>.</c>, a property, a unit.</summary>
    Ident,

    /// <summary>A name directly followed by <c>(</c>: <c>:is(</c>, <c>var(</c>.</summary>
    Function,

    /// <summary>An at-rule's name, its <c>@</c> included.</summary>
    AtKeyword,

    /// <summary>A <c>#</c> and the name after it.</summary>
    Hash,

    /// <summary>A quoted string, its quotes included.</summary>
    String,

    /// <summary>An unquoted <c>url(…)</c>, its parentheses included.</summary>
    Url,

    /// <summary>A number, dimension or percentage.</summary>
    Number,

    /// <summary>Any other single character: <c>.</c>, <c>&amp;</c>, <c>&gt;</c>, <c>*</c>.</summary>
    Delim,

    /// <summary>Spaces, tabs and line breaks.</summary>
    Whitespace,

    /// <summary><c>:</c>.</summary>
    Colon,

    /// <summary><c>;</c>.</summary>
    Semicolon,

    /// <summary><c>,</c>.</summary>
    Comma,

    /// <summary><c>(</c>.</summary>
    ParenOpen,

    /// <summary><c>)</c>.</summary>
    ParenClose,

    /// <summary><c>[</c>.</summary>
    BracketOpen,

    /// <summary><c>]</c>.</summary>
    BracketClose,

    /// <summary><c>{</c>.</summary>
    BraceOpen,

    /// <summary><c>}</c>.</summary>
    BraceClose,

    /// <summary><c>&lt;!--</c>.</summary>
    Cdo,

    /// <summary><c>--&gt;</c>.</summary>
    Cdc,
}

/// <summary>A CSS token: its kind and its span in the stylesheet. [RAZOR-COLLOCATION-CSS]</summary>
internal readonly record struct CssToken(CssTokenKind Kind, TextSpan Span);

/// <summary>
/// The CSS Syntax Module Level 3 tokenizer (https://www.w3.org/TR/css-syntax-3/#tokenization):
/// comments, strings and idents with escapes, numbers and dimensions, unquoted urls,
/// at-keywords, hashes and every bracket. Comments are dropped, as the specification has a
/// parser do, and a <c>.</c> inside a string, a comment, a url, a number or a declaration value
/// is never a selector's dot. [RAZOR-COLLOCATION-CSS]
/// </summary>
internal static class CssTokenizer
{
    /// <summary>The tokens of <paramref name="css"/>, comments excluded.</summary>
    public static List<CssToken> Tokenize(string css)
    {
        var tokens = new List<CssToken>();
        var at = 0;
        while (at < css.Length)
        {
            if (Starts(css, at, "/*"))
            {
                at = CommentEnd(css, at);
                continue;
            }

            var (kind, end) = Token(css, at);
            tokens.Add(new CssToken(kind, TextSpan.FromBounds(at, end)));
            at = Math.Max(end, at + 1);
        }

        return tokens;
    }

    /// <summary>An ident token's value, its escapes decoded.</summary>
    public static string Value(SourceText css, CssToken token)
    {
        return token.Kind == CssTokenKind.Ident ? Unescape(css, token.Span) : "";
    }

    /// <summary>Whether <paramref name="css"/> holds <paramref name="text"/> at <paramref name="at"/>.</summary>
    internal static bool Starts(string css, int at, string text)
    {
        return at >= 0
            && at + text.Length <= css.Length
            && string.CompareOrdinal(css, at, text, 0, text.Length) == 0;
    }

    /// <summary>Whether a name (an ident, a hash or an at-keyword) starts at <paramref name="at"/>.</summary>
    internal static bool StartsName(string css, int at)
    {
        return at < css.Length
            && (IsNameStart(css[at]) || StartsEscape(css, at) || StartsDashName(css, at));
    }

    /// <summary>Where the name starting at <paramref name="at"/> ends, its escapes included.</summary>
    internal static int NameEnd(string css, int at)
    {
        var end = at;
        while (end < css.Length)
        {
            if (IsName(css[end]))
            {
                end++;
                continue;
            }

            if (!StartsEscape(css, end))
            {
                break;
            }

            end = EscapeEnd(css, end);
        }

        return end;
    }

    private static bool StartsDashName(string css, int at)
    {
        return css[at] == '-'
            && at + 1 < css.Length
            && (IsNameStart(css[at + 1]) || css[at + 1] == '-' || StartsEscape(css, at + 1));
    }

    private static (CssTokenKind Kind, int End) Token(string css, int at)
    {
        var c = css[at];
        return c switch
        {
            _ when IsSpace(c) => (CssTokenKind.Whitespace, Run(css, at, IsSpace)),
            '"' or '\'' => (CssTokenKind.String, StringEnd(css, at)),
            '#' => Named(css, at, CssTokenKind.Hash),
            '@' => Named(css, at, CssTokenKind.AtKeyword),
            '<' when Starts(css, at, "<!--") => (CssTokenKind.Cdo, at + 4),
            '-' when Starts(css, at, "-->") => (CssTokenKind.Cdc, at + 3),
            _ when StartsNumber(css, at) => (CssTokenKind.Number, NumberEnd(css, at)),
            _ when StartsName(css, at) => IdentLike(css, at),
            ':' => (CssTokenKind.Colon, at + 1),
            ';' => (CssTokenKind.Semicolon, at + 1),
            ',' => (CssTokenKind.Comma, at + 1),
            '(' => (CssTokenKind.ParenOpen, at + 1),
            ')' => (CssTokenKind.ParenClose, at + 1),
            '[' => (CssTokenKind.BracketOpen, at + 1),
            ']' => (CssTokenKind.BracketClose, at + 1),
            '{' => (CssTokenKind.BraceOpen, at + 1),
            '}' => (CssTokenKind.BraceClose, at + 1),
            _ => (CssTokenKind.Delim, at + 1),
        };
    }

    /// <summary>A hash or an at-keyword: its sigil and the name after it.</summary>
    private static (CssTokenKind Kind, int End) Named(string css, int at, CssTokenKind kind)
    {
        return (kind, StartsName(css, at + 1) ? NameEnd(css, at + 1) : at + 1);
    }

    /// <summary>An ident, a function, or an unquoted url, which the name alone decides.</summary>
    private static (CssTokenKind Kind, int End) IdentLike(string css, int at)
    {
        var end = NameEnd(css, at);
        return end < css.Length && css[end] == '('
            ? Opener(css, at, end)
            : (CssTokenKind.Ident, end);
    }

    private static (CssTokenKind Kind, int End) Opener(string css, int at, int paren)
    {
        return css[at..paren].Equals("url", StringComparison.OrdinalIgnoreCase)
            ? Url(css, paren)
            : (CssTokenKind.Function, paren + 1);
    }

    /// <summary>
    /// <c>url(</c> with a quoted argument is a function whose string follows it; an unquoted one
    /// is a single url token, so a dot inside it is never a selector's.
    /// </summary>
    private static (CssTokenKind Kind, int End) Url(string css, int paren)
    {
        var at = Run(css, paren + 1, IsSpace);
        return at < css.Length && css[at] is '"' or '\''
            ? (CssTokenKind.Function, paren + 1)
            : (CssTokenKind.Url, UrlEnd(css, at));
    }

    private static int UrlEnd(string css, int at)
    {
        while (at < css.Length && css[at] != ')')
        {
            at += css[at] == '\\' ? 2 : 1;
        }

        return Math.Min(at + 1, css.Length);
    }

    /// <summary>A number, a dimension or a percentage; a dimension's unit is part of it.</summary>
    private static int NumberEnd(string css, int at)
    {
        at += css[at] is '+' or '-' ? 1 : 0;
        at = Fraction(css, Run(css, at, char.IsAsciiDigit));
        at = Exponent(css, at);
        return StartsName(css, at)
            ? NameEnd(css, at)
            : at + (at < css.Length && css[at] == '%' ? 1 : 0);
    }

    private static int Fraction(string css, int at)
    {
        return at + 1 < css.Length && css[at] == '.' && char.IsAsciiDigit(css[at + 1])
            ? Run(css, at + 1, char.IsAsciiDigit)
            : at;
    }

    private static int Exponent(string css, int at)
    {
        var sign = at + 1 < css.Length && css[at + 1] is '+' or '-' ? at + 2 : at + 1;
        return
            at < css.Length
            && css[at] is 'e' or 'E'
            && sign < css.Length
            && char.IsAsciiDigit(css[sign])
            ? Run(css, sign, char.IsAsciiDigit)
            : at;
    }

    /// <summary>A string's end, the first unescaped matching quote or the file's end.</summary>
    private static int StringEnd(string css, int at)
    {
        var quote = css[at];
        at++;
        while (at < css.Length && css[at] != quote)
        {
            at += css[at] == '\\' ? 2 : 1;
        }

        return Math.Min(at + 1, css.Length);
    }

    private static int CommentEnd(string css, int at)
    {
        var close = css.IndexOf("*/", at + 2, StringComparison.Ordinal);
        return close < 0 ? css.Length : close + 2;
    }

    /// <summary>An ident's value, its escapes decoded as CSS Syntax §3.3 has them.</summary>
    private static string Unescape(SourceText css, TextSpan span)
    {
        var builder = new StringBuilder(span.Length);
        var at = span.Start;
        while (at < span.End)
        {
            var (text, next) = css[at] == '\\' ? Escape(css, at) : (css[at].ToString(), at + 1);
            _ = builder.Append(text);
            at = next;
        }

        return builder.ToString();
    }

    /// <summary>The character the escape at <paramref name="slash"/> denotes, and the index after it.</summary>
    private static (string Text, int Next) Escape(SourceText css, int slash)
    {
        var at = slash + 1;
        return at >= css.Length ? ("", at)
            : char.IsAsciiHexDigit(css[at]) ? HexEscape(css, at)
            : css[at] is '\n' or '\r' or '\f' ? ("", at + 1)
            : (css[at].ToString(), at + 1);
    }

    private static (string Text, int Next) HexEscape(SourceText css, int at)
    {
        var end = at;
        while (end < css.Length && end - at < 6 && char.IsAsciiHexDigit(css[end]))
        {
            end++;
        }

        var code = Convert.ToInt32(css.ToString(TextSpan.FromBounds(at, end)), 16);
        var next = end < css.Length && IsSpace(css[end]) ? end + 1 : end;
        return (
            code is 0 or > 0x10FFFF or (>= 0xD800 and <= 0xDFFF)
                ? "\uFFFD"
                : char.ConvertFromUtf32(code),
            next
        );
    }

    /// <summary>Where the escape at <paramref name="slash"/> ends, its terminator included.</summary>
    private static int EscapeEnd(string css, int slash)
    {
        var at = slash + 1;
        if (at >= css.Length || !char.IsAsciiHexDigit(css[at]))
        {
            return at + 1;
        }

        while (at < css.Length && at - slash <= 6 && char.IsAsciiHexDigit(css[at]))
        {
            at++;
        }

        return at < css.Length && IsSpace(css[at]) ? at + 1 : at;
    }

    private static bool StartsNumber(string css, int at)
    {
        var c = css[at];
        var next = at + 1 < css.Length ? css[at + 1] : '\0';
        return char.IsAsciiDigit(c)
            || (c is '+' or '-' or '.' && char.IsAsciiDigit(next))
            || (
                c is '+' or '-'
                && next == '.'
                && at + 2 < css.Length
                && char.IsAsciiDigit(css[at + 2])
            );
    }

    private static int Run(string css, int at, Func<char, bool> keep)
    {
        var end = at;
        while (end < css.Length && keep(css[end]))
        {
            end++;
        }

        return end;
    }

    private static bool IsName(char c)
    {
        return IsNameStart(c) || char.IsAsciiDigit(c) || c == '-';
    }

    private static bool IsNameStart(char c)
    {
        return char.IsAsciiLetter(c) || c == '_' || c > 0x7F;
    }

    private static bool StartsEscape(string css, int at)
    {
        return at + 1 < css.Length && css[at] == '\\' && css[at + 1] is not ('\n' or '\r' or '\f');
    }

    private static bool IsSpace(char c)
    {
        return c is ' ' or '\t' or '\n' or '\f' or '\r';
    }
}
