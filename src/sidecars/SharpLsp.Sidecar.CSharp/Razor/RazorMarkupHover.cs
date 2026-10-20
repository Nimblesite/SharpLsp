using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Hover;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Hover on Blazor markup: a component tag answers its type, a component attribute or
/// <c>@bind-X</c> the parameter property it sets, a directive attribute its descriptor's
/// documentation and a directive its description, each ranged on the name. HTML answers
/// nothing: clients forward it. Implements [RAZOR-FEATURES-HOVER].
/// </summary>
internal static class RazorMarkupHover
{
    /// <summary>The hover for the markup name at <paramref name="offset"/>; null off every name.</summary>
    public static HoverResult? At(RazorMarkup markup, Compilation compilation, int offset)
    {
        var named = RazorMarkupSymbols.At(compilation, markup, offset);
        return (named is { } symbol ? Symbol(symbol.Symbol, markup.Text, symbol.Name) : null)
            ?? Attribute(markup, offset)
            ?? Directive(markup, offset);
    }

    /// <summary>A directive attribute, or its parameter, answers the compiler's documentation.</summary>
    private static HoverResult? Attribute(RazorMarkup markup, int offset)
    {
        return markup.AttributeNamedAt(offset) is { NameSpan: { } name } attribute
            ? Described(
                attribute.Name,
                attribute.Parameter?.Documentation ?? attribute.Bound?.Documentation,
                markup.Text,
                name
            )
            : null;
    }

    private static HoverResult? Directive(RazorMarkup markup, int offset)
    {
        var directive = markup.DirectiveNamedAt(offset);
        return directive is null
            ? null
            : Described(
                "@" + directive.Name,
                directive.Descriptor?.Description,
                markup.Text,
                directive.NameSpan
            );
    }

    private static HoverResult? Symbol(ISymbol symbol, SourceText text, TextSpan name)
    {
        var markdown = CSharpHoverBuilder.BuildMarkdown(symbol);
        return markdown.Length == 0 ? null : Result(markdown, text, name);
    }

    /// <summary>A construct the Razor compiler documents: its name as Razor, then the text.</summary>
    private static HoverResult? Described(
        string label,
        string? documentation,
        SourceText text,
        TextSpan name
    )
    {
        return string.IsNullOrWhiteSpace(documentation)
            ? null
            : Result($"```razor\n{label}\n```\n{documentation}", text, name);
    }

    private static HoverResult Result(string markdown, SourceText text, TextSpan name)
    {
        return CSharpHoverBuilder.MakeResult(markdown, text.Lines.GetLinePositionSpan(name));
    }
}
