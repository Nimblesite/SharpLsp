using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The regular-expression syntax inside C# string literals: a literal passed to a parameter
/// marked <c>[StringSyntax("Regex")]</c> (every <c>Regex</c> API) gets <c>regexp</c> tokens
/// over its pattern syntax, so the pattern is not one flat string colour.
/// Implements [SHARPLSP-FEATURES-HIGHLIGHTING-REGEX].
/// </summary>
internal static class RegexLiteralTokens
{
    /// <summary>The legend index of the <c>regexp</c> token type.</summary>
    internal const int RegexpType = 20;

    /// <summary>The <c>regexp</c> spans of every regex literal in <paramref name="span"/>.</summary>
    public static async Task<List<TextSpan>> SpansAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return root is null || model is null
            ? []
            :
            [
                .. root.DescendantTokens(span)
                    .Where(token =>
                        token.Parent is LiteralExpressionSyntax literal
                        && IsRegex(model, literal, ct)
                    )
                    .SelectMany(SyntaxSpans),
            ];
    }

    /// <summary>Whether the literal is the argument of a parameter that takes a regex pattern.</summary>
    private static bool IsRegex(
        SemanticModel model,
        LiteralExpressionSyntax literal,
        CancellationToken ct
    )
    {
        var operation = model.GetOperation(literal, ct)?.Parent;
        while (operation is IConversionOperation)
        {
            operation = operation.Parent;
        }
        return operation is IArgumentOperation { Parameter: { } parameter }
            && parameter
                .GetAttributes()
                .Any(attribute =>
                    attribute.AttributeClass?.Name == "StringSyntaxAttribute"
                    && attribute.ConstructorArguments is [{ Value: "Regex" }, ..]
                );
    }

    /// <summary>The source spans of the pattern syntax in one literal token; none when its characters cannot be placed.</summary>
    private static IEnumerable<TextSpan> SyntaxSpans(SyntaxToken token)
    {
        var places = Places(token);
        return places.Count != token.ValueText.Length
            ? []
            : RegexPatternTokens
                .Of(token.ValueText)
                .Select(range =>
                    TextSpan.FromBounds(places[range.Start].Start, places[range.End - 1].End)
                );
    }

    /// <summary>
    /// Where each character of the literal's value sits in source: a verbatim <c>""</c> and a
    /// regular escape are one character over several. A multi-line or raw multi-line literal,
    /// and a surrogate escape, are not placed (the count then differs from the value's).
    /// </summary>
    private static List<TextSpan> Places(SyntaxToken token)
    {
        var kind = token.Kind();
        return kind == SyntaxKind.SingleLineRawStringLiteralToken ? Raw(token)
            : kind != SyntaxKind.StringLiteralToken
            || token.Text.Contains('\n', StringComparison.Ordinal)
                ? []
            : token.Text.StartsWith('@') ? Verbatim(token)
            : Escaped(token);
    }

    private static List<TextSpan> Verbatim(SyntaxToken token)
    {
        var places = new List<TextSpan>();
        var end = token.Text.Length - 1;
        for (var index = 2; index < end; index++)
        {
            var length = token.Text[index] == '"' ? 2 : 1;
            places.Add(new TextSpan(token.SpanStart + index, length));
            index += length - 1;
        }
        return places;
    }

    private static List<TextSpan> Raw(SyntaxToken token)
    {
        var quotes = token.Text.TakeWhile(character => character == '"').Count();
        return
        [
            .. Enumerable
                .Range(quotes, Math.Max(0, token.Text.Length - (2 * quotes)))
                .Select(index => new TextSpan(token.SpanStart + index, 1)),
        ];
    }

    private static List<TextSpan> Escaped(SyntaxToken token)
    {
        var places = new List<TextSpan>();
        var end = token.Text.Length - 1;
        for (var index = 1; index < end; index++)
        {
            var length = token.Text[index] == '\\' ? EscapeLength(token.Text, index, end) : 1;
            places.Add(new TextSpan(token.SpanStart + index, length));
            index += length - 1;
        }
        return places;
    }

    /// <summary>The source length of the C# escape at <paramref name="at"/>.</summary>
    private static int EscapeLength(string text, int at, int end)
    {
        return text[at + 1] switch
        {
            'u' => 6,
            'U' => 10,
            'x' => 2
                + text.Skip(at + 2)
                    .Take(Math.Min(4, end - at - 2))
                    .TakeWhile(char.IsAsciiHexDigit)
                    .Count(),
            _ => 2,
        };
    }
}
