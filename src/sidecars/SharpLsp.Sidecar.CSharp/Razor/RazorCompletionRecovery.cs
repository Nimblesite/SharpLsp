using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Completion in a C# expression the Razor compiler cannot finish yet. The compiler leaves the
/// dot of <c>@scores.</c> in the markup, and an <c>@(</c> that is missing its <c>)</c> runs on
/// through the markup after it, calls and lambdas inside it included, so neither projection
/// holds the member access being typed. Completion asks a copy of the file whose expression is
/// finished at the caret.
/// Implements [RAZOR-FEATURES-COMPLETION].
/// </summary>
internal static class RazorCompletionRecovery
{
    /// <summary>The Razor compiler's diagnostic for a block that is missing its closing character.</summary>
    private const string MissingClose = "RZ1006";

    /// <summary>The parentheses of an explicit expression.</summary>
    private static readonly string Open = SyntaxFacts.GetText(SyntaxKind.OpenParenToken);

    private static readonly string Close = SyntaxFacts.GetText(SyntaxKind.CloseParenToken);

    /// <summary>
    /// The insertions, in text order, that finish the expression at <paramref name="caret"/>;
    /// none when the projection already holds it. The compiler's <paramref name="diagnostics"/>
    /// are read only when the projection's C# does not parse.
    /// </summary>
    public static async Task<ImmutableArray<TextChange>> FinishAsync(
        RazorProjection projection,
        int caret,
        Func<Task<IEnumerable<MarkupDiagnostic>>> diagnostics
    )
    {
        return projection.Map.ToGenerated(caret) is null ? TrailingDot(projection, caret)
            : projection.GeneratedRoot.ContainsDiagnostics
                ? Unclosed(projection, await diagnostics().ConfigureAwait(false), caret)
            : [];
    }

    /// <summary>
    /// <c>@scores.</c> as <c>@(scores.)</c>: a fragment ends at the dot before the caret, and
    /// with that dot it reads as a member access whose name is still missing.
    /// </summary>
    private static ImmutableArray<TextChange> TrailingDot(RazorProjection projection, int caret)
    {
        var fragment = projection.Map.Mappings.FirstOrDefault(entry =>
            entry.Length > 0 && entry.RazorEnd == caret - 1
        );
        return
            fragment.Length > 0
            && NamesNoMember(
                projection.RazorText.ToString(TextSpan.FromBounds(fragment.RazorStart, caret))
            )
            ? [Insert(fragment.RazorStart, Open), Insert(caret, Close)]
            : [];
    }

    /// <summary>Whether <paramref name="expression"/> is all one member access missing its name.</summary>
    private static bool NamesNoMember(string expression)
    {
        return SyntaxFactory.ParseExpression(expression)
                is MemberAccessExpressionSyntax { Name.IsMissing: true } access
            && access.FullSpan.Length == expression.Length;
    }

    /// <summary>
    /// <c>@(scores.</c> as <c>@(scores.)</c>, and <c>@(basket.MinBy(p => p.</c> as
    /// <c>@(basket.MinBy(p => p.))</c>: the fragment holding the caret opens just after a
    /// <c>(</c> that the compiler reports missing its close. An unclosed <c>@{</c> needs no
    /// help: the compiler's recovery keeps its code.
    /// </summary>
    private static ImmutableArray<TextChange> Unclosed(
        RazorProjection projection,
        IEnumerable<MarkupDiagnostic> diagnostics,
        int caret
    )
    {
        var fragment = projection.Map.Mappings.FirstOrDefault(entry =>
            entry.Length > 0 && entry.RazorStart <= caret && caret <= entry.RazorEnd
        );
        return
            fragment.Length > 0
            && diagnostics.Any(diagnostic =>
                diagnostic.Id == MissingClose
                && diagnostic.Span.End == fragment.RazorStart
                && OpensExpression(projection.RazorText.ToString(diagnostic.Span))
            )
            ? [Insert(caret, Closing(TextSpan.FromBounds(fragment.RazorStart, caret), projection))]
            : [];
    }

    /// <summary>
    /// What closes the explicit expression whose C# runs over <paramref name="typed"/>: each
    /// <c>)</c>, <c>]</c> and <c>}</c> Roslyn's parser supplies for what the C# leaves open,
    /// innermost first, then the expression's own <c>)</c>.
    /// </summary>
    private static string Closing(TextSpan typed, RazorProjection projection)
    {
        return SyntaxFactory
            .TokenList(
                SyntaxFactory
                    .ParseExpression(projection.RazorText.ToString(typed))
                    .DescendantTokens()
                    .Where(token => token.IsMissing && Closes(token.Kind()))
                    .Select(token => SyntaxFactory.Token(token.Kind()))
                    .Append(SyntaxFactory.Token(SyntaxKind.CloseParenToken))
            )
            .ToFullString();
    }

    private static bool Closes(SyntaxKind kind)
    {
        return kind
            is SyntaxKind.CloseParenToken
                or SyntaxKind.CloseBracketToken
                or SyntaxKind.CloseBraceToken;
    }

    /// <summary>Whether <paramref name="text"/> is the <c>(</c> that opens an explicit expression.</summary>
    private static bool OpensExpression(string text)
    {
        return SyntaxFactory.ParseToken(text).IsKind(SyntaxKind.OpenParenToken);
    }

    private static TextChange Insert(int at, string text)
    {
        return new TextChange(new TextSpan(at, 0), text);
    }
}
