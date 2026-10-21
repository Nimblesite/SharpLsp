using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A class selector a stylesheet declares: its name, with its escapes decoded, and the span of
/// the class name after its <c>.</c>. [RAZOR-COLLOCATION-CSS]
/// </summary>
internal readonly record struct CssClass(string Name, TextSpan Span);

/// <summary>
/// A collocated stylesheet: the classes its rule preludes declare, in the order they appear.
/// Only a rule's prelude names selectors, so a class written in a declaration value, a string,
/// a comment or a url is never one. Implements [RAZOR-COLLOCATION-CSS].
/// </summary>
internal sealed record RazorStylesheet(
    string FilePath,
    SourceText Text,
    IReadOnlyList<CssClass> Classes
)
{
    /// <summary>The distinct class names the stylesheet declares, in the order they first appear.</summary>
    public IReadOnlyList<string> Names { get; } =
    [.. Classes.Select(cssClass => cssClass.Name).Distinct(StringComparer.Ordinal)];

    /// <summary>The stylesheet <paramref name="filePath"/> holds, read from its text.</summary>
    public static RazorStylesheet Parse(string filePath, SourceText text)
    {
        return new RazorStylesheet(filePath, text, RazorStylesheetReader.ClassesOf(text));
    }
}

/// <summary>
/// Reads the class selectors of a stylesheet from the tokens of the CSS Syntax Module Level 3
/// tokenizer. Every <c>{</c> ends a prelude: an at-rule's preludes are skipped, and a rule's
/// own yields each <c>.</c> immediately followed by an ident. Blocks nest, so at-rules inside
/// at-rules and nested rules read the same way. Implements [RAZOR-COLLOCATION-CSS].
/// </summary>
internal static class RazorStylesheetReader
{
    /// <summary>Every class selector occurrence of <paramref name="css"/>, in source order.</summary>
    public static IReadOnlyList<CssClass> ClassesOf(SourceText css)
    {
        var tokens = CssTokenizer.Tokenize(css.ToString());
        var classes = new List<CssClass>();
        var prelude = 0;
        for (var at = 0; at < tokens.Count; at++)
        {
            if (tokens[at].Kind == CssTokenKind.BraceOpen && IsSelectorPrelude(tokens, prelude, at))
            {
                classes.AddRange(ClassesIn(css, tokens, prelude, at));
            }

            prelude = StartsPrelude(tokens[at]) ? at + 1 : prelude;
        }

        return classes;
    }

    /// <summary>Whether the block a <c>{</c> opens starts a prelude of its own after it.</summary>
    private static bool StartsPrelude(CssToken token)
    {
        return token.Kind
            is CssTokenKind.BraceOpen
                or CssTokenKind.BraceClose
                or CssTokenKind.Semicolon;
    }

    /// <summary>Whether the tokens from <paramref name="start"/> name a rule's selectors, not an at-rule.</summary>
    private static bool IsSelectorPrelude(List<CssToken> tokens, int start, int end)
    {
        // A default token's empty span stands for a prelude holding nothing but whitespace.
        var first = tokens.Skip(start).Take(end - start).FirstOrDefault(NotSpace);
        return first.Span.Length > 0
            && first.Kind is not (CssTokenKind.AtKeyword or CssTokenKind.Cdo or CssTokenKind.Cdc);
    }

    private static bool NotSpace(CssToken token)
    {
        return token.Kind != CssTokenKind.Whitespace;
    }

    /// <summary>The classes of a prelude: each <c>.</c> and the ident right after it.</summary>
    private static IEnumerable<CssClass> ClassesIn(
        SourceText css,
        List<CssToken> tokens,
        int start,
        int end
    )
    {
        return Enumerable
            .Range(start, end - start)
            .Where(at => IsClassDot(css, tokens, at))
            .Select(at => tokens[at + 1])
            .Select(ident => new CssClass(CssTokenizer.Value(css, ident), ident.Span));
    }

    /// <summary>Whether the token is a <c>.</c> directly followed by the ident naming a class.</summary>
    private static bool IsClassDot(SourceText css, List<CssToken> tokens, int at)
    {
        return tokens[at].Kind == CssTokenKind.Delim
            && IsDot(css, tokens[at])
            && tokens[at + 1].Kind == CssTokenKind.Ident
            && tokens[at + 1].Span.Start == tokens[at].Span.End;
    }

    private static bool IsDot(SourceText css, CssToken token)
    {
        return token.Span.Length == 1 && css[token.Span.Start] == '.';
    }
}
