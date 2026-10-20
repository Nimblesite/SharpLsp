#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Hover on Blazor markup, against the real fixture solution: a component tag answers its
/// type, a component attribute or <c>@bind-X</c> its parameter property, a directive
/// attribute its descriptor's documentation and a directive its description, each ranged
/// on the name. HTML stays the client's. Implements [RAZOR-TESTING] for
/// [RAZOR-FEATURES-HOVER].
/// </summary>
public sealed class RazorMarkupHoverTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupHoverTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Component_tags_and_their_attributes_answer_their_types_and_parameters()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // The start tag answers the component's type and summary, ranged on its name.
        var badge = RazorFixture.Locate(Board, "<Badge Text=", "Badge");
        var start = await HoverAsync(manager, badge, 1);
        Assert.Contains("Badge", start.Contents, StringComparison.Ordinal);
        Assert.Contains("A small label beside a tally.", start.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(badge, "Badge"), Range(start));

        // The end tag answers the same way.
        var tally = RazorFixture.Locate(Board, "</Tally>", "Tally");
        var end = await HoverAsync(manager, tally, 0);
        Assert.Contains("Tally", end.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(tally, "Tally"), Range(end));

        // A parameter answers its property, and `@bind-Label` the property it binds.
        var text = RazorFixture.Locate(Board, "<Badge Text=", "Text");
        var parameter = await HoverAsync(manager, text, 1);
        Assert.Contains("The badge's text.", parameter.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(text, "Text"), Range(parameter));
        // On `@bind-` the markup answers, ranged on the whole name; on `Label` the C#
        // the projection maps there answers, ranged on that token.
        var bind = RazorFixture.Locate(Board, "@bind-Label=", "@bind-Label");
        var directive = await HoverAsync(manager, bind, 2);
        Assert.Contains("The tally's caption.", directive.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(bind, "@bind-Label"), Range(directive));
        var label = RazorFixture.Locate(Board, "@bind-Label=", "Label");
        var bound = await HoverAsync(manager, label, 1);
        Assert.Contains("The tally's caption.", bound.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(label, "Label"), Range(bound));
    }

    [Fact]
    public async Task Directive_attributes_and_directives_answer_the_compilers_documentation()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);

        // `@onclick` answers its descriptor's documentation.
        var onclick = RazorFixture.Locate(Board, "<button @onclick", "@onclick");
        var documented = Assert.Single(markup.Attributes, a => a.Name == "@onclick").Bound;
        Assert.False(string.IsNullOrEmpty(documented?.Documentation));
        var handler = await HoverAsync(manager, onclick, 2);
        Assert.Contains(documented.Documentation, handler.Contents, StringComparison.Ordinal);
        Assert.Equal(Range(onclick, "@onclick"), Range(handler));

        // `@page` answers the directive's description.
        var page = RazorFixture.Locate(Board, "@page", "page");
        var directive = Assert.Single(markup.Directives, d => d.Name == "page").Descriptor;
        Assert.False(string.IsNullOrEmpty(directive?.Description));
        var routed = await HoverAsync(manager, page, 1);
        Assert.Contains(directive.Description, routed.Contents, StringComparison.Ordinal);

        // HTML stays the client's: a plain element answers nothing from the server.
        var button = RazorFixture.Locate(Board, "<button @onclick", "button");
        Assert.Null(
            RazorFixture.Ok(await manager.GetHoverAsync(Board, button.Line, button.Character))
        );
    }

    private async Task<HoverResult> HoverAsync(
        Workspace.WorkspaceManager manager,
        (int Line, int Character) at,
        int offset
    )
    {
        var hover = RazorFixture.Ok(
            await manager.GetHoverAsync(Board, at.Line, at.Character + offset)
        );
        Assert.NotNull(hover);
        return hover;
    }

    private static (int?, int?, int?, int?) Range(HoverResult hover)
    {
        return (hover.StartLine, hover.StartCharacter, hover.EndLine, hover.EndCharacter);
    }

    private static (int?, int?, int?, int?) Range((int Line, int Character) at, string name)
    {
        return (at.Line, at.Character, at.Line, at.Character + name.Length);
    }
}
