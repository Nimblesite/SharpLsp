using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The collocated stylesheet reader and its CSS Syntax Module Level 3 tokenizer: class
/// selectors come from rule preludes only, so a comment, a string, a declaration value or a
/// url never yields one, while at-rules, <c>::deep</c>, <c>:is()</c> and escaped names all do.
/// Implements [RAZOR-TESTING] for [RAZOR-COLLOCATION-CSS].
/// </summary>
public sealed class RazorStylesheetTests
{
    [Fact]
    public void Classes_come_from_rule_preludes_only()
    {
        Assert.Equal(
            ["card", "panel", "title"],
            Names(".card { color: red; } .panel .title { font-weight: 600; }")
        );
        // Compound and comma-separated selectors each name their classes once.
        Assert.Equal(["a", "b", "c"], Names(".a.b, .c { color: red; }"));
        // A `.` with no ident after it is no class.
        Assert.Empty(Names("a. { color: red; }"));
    }

    [Fact]
    public void A_comment_contributes_no_class_and_hides_its_braces()
    {
        Assert.Equal(["real"], Names("/* } .fake { .alsoFake { } */ .real { color: red; }"));
        // An unterminated comment swallows the rest of the stylesheet.
        Assert.Equal(["real"], Names(".real { } /* unterminated .fake { "));
        // A comment inside a prelude hides nothing that follows it.
        Assert.Equal(["before", "after"], Names(".before /* .fake */ .after { }"));
    }

    [Fact]
    public void A_string_never_contributes_a_class()
    {
        // An attribute selector's string holds a dot, and the selector names no class.
        Assert.Empty(Names("a[href$=\".pdf\"] { color: red; }"));
        // A declaration's string holds both a dot and a brace.
        Assert.Equal(["labeled"], Names(".labeled { content: \"a.b}\"; }"));
        // An escaped quote does not end the string early.
        Assert.Equal(["kept"], Names(".kept { content: \"\\\" .fake {\"; }"));
    }

    [Fact]
    public void Declaration_values_and_urls_never_contribute_classes()
    {
        const string Css =
            ".spaced { margin: .5rem; background: url(a.b.png); grid-area: zone; } .after { }";
        Assert.Equal(["spaced", "after"], Names(Css));
        // A quoted url is still no selector, and its string holds no class either.
        Assert.Equal(["backed"], Names(".backed { background: url(\"x.y.png\"); }"));
        // A number's unit is part of its number.
        Assert.Equal(["sized"], Names(".sized { width: 1.5rem; height: 0.25em; }"));
    }

    [Fact]
    public void At_rules_never_name_a_class_but_the_rules_inside_them_do()
    {
        const string Css =
            "@media (min-width: 641px) { .wide { color: red; } "
            + "@supports (display: grid) { .grid .cell { display: grid; } } }";
        Assert.Equal(["wide", "grid", "cell"], Names(Css));
        // An at-rule's own prelude holds a class only in a function's argument.
        Assert.Empty(Names("@supports selector(.fake) { }"));
        // A statement at-rule ends at its semicolon.
        Assert.Equal(["imported"], Names("@import url(a.css); .imported { }"));
    }

    [Fact]
    public void Deep_combinators_and_pseudo_classes_read_as_selectors()
    {
        const string Css =
            ".card::deep .card__title { color: red; } .title:is(.accent, .muted) { color: blue; }";
        Assert.Equal(["card", "card__title", "title", "accent", "muted"], Names(Css));
        // Nested rules of CSS nesting read the same way.
        Assert.Equal(["outer", "inner"], Names(".outer { & .inner, &:hover { } }"));
    }

    [Fact]
    public void Escapes_in_idents_are_decoded()
    {
        // `\.` is part of the name, and `\31 ` is a `1`.
        Assert.Equal(["p-1.5", "w-10"], Names(".p-1\\.5 { } .w-\\31 0 { }"));
        // The span stays on the raw text, escapes and all.
        const string Css = ".p-1\\.5 { }";
        var spaced = Assert.Single(Read(Css));
        Assert.Equal("p-1\\.5", Css[spaced.Span.Start..spaced.Span.End]);
        Assert.Equal("p-1.5", spaced.Name);
    }

    [Fact]
    public void Every_occurrence_is_reported_on_the_name_after_its_dot()
    {
        const string Css = ".card .title { } .title { } .title:is(.muted) { }";
        var classes = Read(Css);
        Assert.Equal(5, classes.Count);
        Assert.All(
            classes,
            cssClass => Assert.Equal(cssClass.Name, Css[cssClass.Span.Start..cssClass.Span.End])
        );
        Assert.Equal(1, classes[0].Span.Start);
        Assert.Equal(7, classes[1].Span.Start);
        // The distinct names keep their first appearance's order.
        Assert.Equal(
            ["card", "title", "muted"],
            RazorStylesheet.Parse("/app/x.razor.css", SourceText.From(Css)).Names
        );
    }

    [Fact]
    public void Unterminated_blocks_strings_and_comments_are_tolerated()
    {
        // A string that never closes keeps the braces after it out of the stylesheet.
        Assert.Equal(["real"], Names(".real { content: \"unterminated; } .fake { }"));
        Assert.Empty(Names("/* no end .fake { "));
        Assert.Equal(["open"], Names(".open { color: red; "));
    }

    [Fact]
    public void The_tokenizer_follows_the_css_syntax_tokenization()
    {
        Assert.Equal(
            [
                (CssTokenKind.Ident, "a"),
                (CssTokenKind.Delim, "."),
                (CssTokenKind.Ident, "b"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.BraceOpen, "{"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.Ident, "margin"),
                (CssTokenKind.Colon, ":"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.Number, ".5rem"),
                (CssTokenKind.Semicolon, ";"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.BraceClose, "}"),
            ],
            Tokens("a.b { margin: .5rem; }")
        );

        // An unquoted url is one token; a quoted one is a function and a string.
        Assert.Equal([(CssTokenKind.Url, "url(a.b.png)")], Tokens("url(a.b.png)"));
        Assert.Equal(
            [
                (CssTokenKind.Function, "url("),
                (CssTokenKind.String, "\"a.b.png\""),
                (CssTokenKind.ParenClose, ")"),
            ],
            Tokens("url(\"a.b.png\")")
        );

        // At-keywords, hashes, functions and the HTML comment markers have their own kinds.
        Assert.Equal(
            [
                (CssTokenKind.AtKeyword, "@media"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.Colon, ":"),
                (CssTokenKind.Function, "is("),
                (CssTokenKind.Hash, "#id"),
                (CssTokenKind.Cdo, "<!--"),
                (CssTokenKind.Whitespace, " "),
                (CssTokenKind.Cdc, "-->"),
            ],
            Tokens("@media :is(#id<!-- -->")
        );
    }

    /// <summary>The class selectors of <paramref name="css"/>, in source order.</summary>
    private static IReadOnlyList<CssClass> Read(string css)
    {
        return RazorStylesheet.Parse("/app/Razor.razor.css", SourceText.From(css)).Classes;
    }

    /// <summary>The names of the class selectors of <paramref name="css"/>.</summary>
    private static IReadOnlyList<string> Names(string css)
    {
        return [.. Read(css).Select(cssClass => cssClass.Name)];
    }

    /// <summary>Each token of <paramref name="css"/> with its text.</summary>
    private static List<(CssTokenKind Kind, string Text)> Tokens(string css)
    {
        return
        [
            .. CssTokenizer
                .Tokenize(css)
                .Select(token => (token.Kind, css[token.Span.Start..token.Span.End])),
        ];
    }
}
