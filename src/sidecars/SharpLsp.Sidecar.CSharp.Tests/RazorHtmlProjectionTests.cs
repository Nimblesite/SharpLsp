using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Real workspace coverage of [RAZOR-ARCHITECTURE-HTML] and [RAZOR-TESTING].</summary>
public sealed class RazorHtmlProjectionTests(RazorFixture fixture) : IClassFixture<RazorFixture>
{
    [Fact]
    public async Task Source_less_directive_names_have_no_invented_span()
    {
        using var manager = await fixture.OpenManagerAsync();
        var path = fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");
        var markup = await manager.FindRazorMarkupAsync(path, default);
        Assert.NotNull(markup);
        var click = Assert.Single(markup.Attributes, attribute => attribute.Name == "@onclick");
        Assert.Null(RazorIr.DirectiveName(null, click.Name, markup.Text));
        _ = Assert.NotNull(click.NameSpan);
        Assert.Equal(click.Name, markup.Text.ToString(click.NameSpan.Value));
    }

    [Theory]
    [InlineData("BlazorApp", "Components", "Pages", "Board.razor")]
    [InlineData("PagesApp", "Views", "Home", "Index.cshtml")]
    public async Task Projection_preserves_html_and_masks_razor_in_current_workspace_text(
        string project,
        string folder,
        string subfolder,
        string file
    )
    {
        using var manager = await fixture.OpenManagerAsync();
        var path = fixture.Path(project, folder, subfolder, file);
        const string text =
            "@using System\r\n@* hidden <fake> *@\r\n<div title=\"hello @DateTime.Now!\">@(1 + 2)<b>ok</b></div>\r\n@{ var number = 4; <p>@number</p> }";
        _ = await manager.UpdateDocumentTextAsync(path, text);
        var markup = await manager.FindRazorMarkupAsync(path, default);
        Assert.NotNull(markup);
        AssertMask(markup.HtmlText);
        AssertOffsets(text, markup.HtmlText);
        Assert.Equal(
            MarkupContext.TagName,
            markup.ContextAt(text.IndexOf("<div", StringComparison.Ordinal) + 2)
        );
        Assert.Equal(
            MarkupContext.AttributeValue,
            markup.ContextAt(text.IndexOf("hello", StringComparison.Ordinal) + 1)
        );
    }

    private static void AssertMask(string html)
    {
        Assert.Contains("<div title=\"hello              !\">", html, StringComparison.Ordinal);
        Assert.Contains("<b>ok</b></div>", html, StringComparison.Ordinal);
        Assert.Contains("<p>       </p>", html, StringComparison.Ordinal);
        Assert.DoesNotContain("fake", html, StringComparison.Ordinal);
        Assert.DoesNotContain("using", html, StringComparison.Ordinal);
    }

    private static void AssertOffsets(string original, string html)
    {
        Assert.Equal(original.Length, html.Length);
        Assert.All(
            Enumerable.Range(0, original.Length).Where(i => original[i] is '\r' or '\n'),
            i => Assert.Equal(original[i], html[i])
        );
    }

    [Theory]
    [InlineData("<p>😀 @DateTime.Now</p>", "<p>😀              </p>")]
    [InlineData("<p>@@hello</p>", "<p> @hello</p>")]
    [InlineData(
        "<div title='@((1 > 0) ? \"yes\" : \"no\")'>ok</div>",
        "<div title='                         '>ok</div>"
    )]
    [InlineData(
        "<div><!-- static comment --><br /></div>",
        "<div><!-- static comment --><br /></div>"
    )]
    [InlineData("<input disabled>", "<input disabled>")]
    [InlineData("<div>ok</div >", "<div>ok</div >")]
    [InlineData("<div>ok</DIV>", "<div>ok</DIV>")]
    [InlineData("<div title", "<div title")]
    [InlineData("<di", "<di")]
    [InlineData("<div title='x", "<div title='x")]
    [InlineData("<!-- @DateTime.Now -->", "<!-- @DateTime.Now -->")]
    [InlineData("<!-- unfinished", "<!-- unfinished")]
    [InlineData("@* <!-- hidden --> *@<!-- keep -->", "                     <!-- keep -->")]
    // [RAZOR-ARCHITECTURE-HTML]: a directive attribute and the C# inside an HTML attribute
    // value are both blank; HTML names, quotes and literal text stay.
    [InlineData(
        "<button @onclick=\"() => Add(1)\" disabled=\"@(scores.Count > 9)\">Add</button>",
        "<button                         disabled=\"                   \">Add</button>"
    )]
    [InlineData(
        "<button disabled=\"@(scores.Count > 9)\">Add</button>",
        "<button disabled=\"                   \">Add</button>"
    )]
    [InlineData(
        "<button @onclick=\"() => Add(1)\" @onclick:stopPropagation>Add</button>",
        "<button                                                 >Add</button>"
    )]
    [InlineData(
        "<input @bind=\"name\" @bind:event=\"oninput\" />",
        "<input                                    />"
    )]
    // The compiler gives a minimized directive parameter no span, nor a minimized HTML
    // attribute before it; both are read in order, and only the directive is blank.
    [InlineData(
        "<button disabled @onclick:stopPropagation @onclick=\"() => Add(1)\">Add</button>",
        "<button disabled                                                 >Add</button>"
    )]
    [InlineData(
        "<button title=\"Add one\" @onclick:stopPropagation>Add</button>",
        "<button title=\"Add one\"                         >Add</button>"
    )]
    public async Task Projection_query_preserves_html_and_utf16_offsets(
        string text,
        string expected
    )
    {
        using var manager = await fixture.OpenManagerAsync();
        var path = fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(path, text));
        var projection = RazorFixture.Ok(await manager.GetRazorHtmlProjectionAsync(path, default));
        Assert.NotNull(projection);
        Assert.Equal(text.Length, projection.Text.Length);
        Assert.Equal(expected, projection.Text);
    }

    [Theory]
    [InlineData("@code { string Hidden = \"<!-- hidden -->\"; }<!-- keep -->")]
    [InlineData("@{ string hidden = \"<!-- hidden -->\"; }<!-- keep -->")]
    public async Task Html_comments_inside_csharp_strings_stay_masked(string text)
    {
        using var manager = await fixture.OpenManagerAsync();
        var path = fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(path, text));
        var projection = RazorFixture.Ok(await manager.GetRazorHtmlProjectionAsync(path, default));
        Assert.NotNull(projection);
        Assert.Equal(text.Length, projection.Text.Length);
        Assert.DoesNotContain("hidden", projection.Text, StringComparison.Ordinal);
        Assert.EndsWith("<!-- keep -->", projection.Text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Projection_query_returns_null_for_unlisted_and_non_razor_documents()
    {
        using var manager = await fixture.OpenManagerAsync();
        foreach (
            var path in new[]
            {
                fixture.Path("Absent.razor"),
                fixture.Path("BlazorApp", "Program.cs"),
            }
        )
        {
            var projection = RazorFixture.Ok(
                await manager.GetRazorHtmlProjectionAsync(path, default)
            );
            Assert.Null(projection);
            Assert.Null(await manager.FindRazorMarkupAsync(path, default));
        }
    }

    [Fact]
    public async Task Projection_retains_component_tags_and_reacts_to_unsaved_edits()
    {
        using var manager = await fixture.OpenManagerAsync();
        var path = fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");
        var before = await manager.FindRazorMarkupAsync(path, default);
        Assert.NotNull(before);
        Assert.Contains("<Panel", before.HtmlText, StringComparison.Ordinal);
        Assert.Contains("</Panel>", before.HtmlText, StringComparison.Ordinal);
        Assert.DoesNotContain("@code", before.HtmlText, StringComparison.Ordinal);
        // The fixture's C# attribute value and directive attributes are blank too (#407).
        Assert.DoesNotContain("scores.Count", before.HtmlText, StringComparison.Ordinal);
        Assert.DoesNotContain("@bind", before.HtmlText, StringComparison.Ordinal);
        Assert.DoesNotContain("oninput", before.HtmlText, StringComparison.Ordinal);
        Assert.Contains("<input", before.HtmlText, StringComparison.Ordinal);
        _ = await manager.UpdateDocumentTextAsync(
            path,
            "<article data-test='changed'>@DateTime.Now</article>"
        );
        var after = await manager.FindRazorMarkupAsync(path, default);
        Assert.NotNull(after);
        Assert.Equal("<article data-test='changed'>             </article>", after.HtmlText);
        Assert.DoesNotContain("Panel", after.HtmlText, StringComparison.Ordinal);
    }
}
