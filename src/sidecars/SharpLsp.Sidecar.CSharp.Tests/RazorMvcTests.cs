using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Razor Pages and MVC views against the real fixture's PagesApp: <c>@model</c>,
/// <c>@inject</c>, <c>@functions</c> and <c>@section</c> through the projection, tag helper
/// elements and attributes from their descriptors, and <c>_ViewImports.cshtml</c> as an
/// import. Implements [RAZOR-TESTING] for [RAZOR-MVC].
/// </summary>
public sealed class RazorMvcTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMvcTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Edit => _fixture.Path("PagesApp", "Pages", "Edit.cshtml");

    private string Index => _fixture.Path("PagesApp", "Views", "Home", "Index.cshtml");

    [Fact]
    public async Task Model_inject_and_functions_answer_through_the_projection()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // `@model`'s type is C#, and so is `Model.X`.
        var model = await HoverAsync(
            manager,
            Edit,
            RazorFixture.Locate(Edit, "@model EditModel", "EditModel")
        );
        Assert.Contains("Edits one item.", model, StringComparison.Ordinal);
        var title = await HoverAsync(
            manager,
            Edit,
            RazorFixture.Locate(Edit, "@Shout(Model.Title)", "Title")
        );
        Assert.Contains("The item's title.", title, StringComparison.Ordinal);

        // `@inject` declares a property of its type, and `@functions` members are C#.
        var log = await HoverAsync(
            manager,
            Edit,
            RazorFixture.Locate(Edit, "@inject ILogger", "Log")
        );
        Assert.Contains("ILogger<", log, StringComparison.Ordinal);
        var call = RazorFixture.Locate(Edit, "@Shout(Model.Title)", "Shout");
        var shout = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Edit, call.Line, call.Character))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Edit, shout.FilePath), shout.FilePath);
        Assert.Equal(
            RazorFixture.Locate(Edit, "string Shout", "Shout"),
            (shout.Line, shout.Character)
        );
    }

    [Fact]
    public async Task ViewImports_imports_reach_the_views_below_them()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Views/_ViewImports.cshtml's `@using PagesApp.Models` resolves `@model Item`...
        var item = await HoverAsync(
            manager,
            Index,
            RazorFixture.Locate(Index, "@model Item", "Item")
        );
        Assert.Contains("An item the home page shows.", item, StringComparison.Ordinal);
        Assert.DoesNotContain(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(Index)),
            diagnostic => diagnostic.Severity == "Error"
        );

        // ...and its `@addTagHelper` binds the anchor tag helper.
        var markup = await manager.FindRazorMarkupAsync(Index, default);
        Assert.NotNull(markup);
        var anchor = Assert.Single(markup.Tags, tag => tag.Name == "a");
        Assert.Contains(
            anchor.MvcTagHelpers,
            helper => helper.Name.EndsWith("AnchorTagHelper", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Tag_helper_elements_and_attributes_answer_hover_from_their_descriptors()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // An element a tag helper binds answers the tag helper's type.
        var input = await HoverAsync(
            manager,
            Edit,
            RazorFixture.Locate(Edit, "<input asp-for", "input"),
            1
        );
        Assert.Contains("InputTagHelper", input, StringComparison.Ordinal);

        // `asp-for` answers the property it sets.
        var aspFor = await HoverAsync(
            manager,
            Edit,
            RazorFixture.Locate(Edit, "<input asp-for", "asp-for"),
            1
        );
        Assert.Contains("ModelExpression", aspFor, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Tag_helper_attributes_complete_in_an_element_start_tag()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Edit) + "\n<a asp-";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Edit, text));
        var lines = text.Split('\n');

        var items = RazorFixture.Ok(
            await manager.GetCompletionsAsync(Edit, lines.Length - 1, lines[^1].Length)
        );

        Assert.Contains(items, item => item.Label == "asp-page");
        Assert.Contains(items, item => item.Label == "asp-controller");
        Assert.Contains(items, item => item.Label == "asp-route-");
        var page = Assert.Single(items, item => item.Label == "asp-page");
        Assert.Equal("Property", page.Kind);
    }

    [Fact]
    public async Task Tag_helper_elements_complete_after_an_open_angle_bracket()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var original = await File.ReadAllTextAsync(Edit);

        // After `<`, every element a tag helper in scope targets by name completes, with the
        // tag helper that binds it, replacing the name typed so far. [RAZOR-MVC-TAGHELPERS]
        var items = await CompletedAsync(manager, original + "\n<pa");
        var partial = Assert.Single(items, item => item.Label == "partial");
        Assert.Equal("Class", partial.Kind);
        Assert.Contains("PartialTagHelper", partial.Detail, StringComparison.Ordinal);
        Assert.Equal("pa", ReplacedText(original + "\n<pa", partial));
        Assert.Contains(items, item => item.Label == "environment");
        var anchor = Assert.Single(items, item => item.Label == "a");
        Assert.Contains("AnchorTagHelper", anchor.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain(items, item => item.Label == "*");

        // `@tagHelperPrefix` spells each element with its prefix...
        var prefixed = await CompletedAsync(manager, "@tagHelperPrefix th:\n" + original + "\n<");
        Assert.Contains(prefixed, item => item.Label == "th:partial");
        Assert.DoesNotContain(prefixed, item => item.Label == "partial");

        // ...and `@removeTagHelper *` takes the assembly's elements away, leaving those of the
        // default imports' URL resolution tag helper, which still binds `a`.
        const string none = "@removeTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers";
        var removed = await CompletedAsync(manager, original + "\n" + none + "\n<");
        Assert.DoesNotContain(removed, item => item.Label is "partial" or "environment");
        var resolved = Assert.Single(removed, item => item.Label == "a");
        Assert.Contains("UrlResolutionTagHelper", resolved.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("AnchorTagHelper", resolved.Detail, StringComparison.Ordinal);

        // A legacy file binds no component by its tag, so none completes. [RAZOR-MVC-SCOPE]
        Assert.DoesNotContain(items, item => item.Label is "ErrorBoundary" or "Virtualize");
        Assert.DoesNotContain(
            items,
            item =>
                item.Detail?.StartsWith("Microsoft.AspNetCore.Components", StringComparison.Ordinal)
                == true
        );
    }

    [Fact]
    public async Task Model_expressions_and_section_code_get_csharp_features()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // An `asp-for` value is a model expression: C# hover and definition. [RAZOR-MVC]
        var at = RazorFixture.Locate(Edit, "<input asp-for", "Title");
        var hover = await HoverAsync(manager, Edit, at);
        Assert.Contains("The item's title.", hover, StringComparison.Ordinal);
        var title = Assert.Single(
            RazorFixture.Ok(await manager.GetDefinitionAsync(Edit, at.Line, at.Character)).Locations
        );
        var code = _fixture.Path("PagesApp", "Pages", "Edit.cshtml.cs");
        Assert.True(NativePaths.AreEqual(code, title.FilePath), title.FilePath);
        Assert.Equal(RazorFixture.Locate(code, "public string Title", "Title").Line, title.Line);
        var references = RazorFixture.Ok(
            await manager.GetReferencesAsync(code, title.Line, title.Character, true)
        );
        Assert.Equal(
            4,
            references.Locations.Count(location => NativePaths.AreEqual(Edit, location.FilePath))
        );
        var rename = RazorFixture.Ok(
            await manager.RenameAsync(code, title.Line, title.Character, "Heading")
        );
        var view = Assert.Single(
            rename.DocumentChanges,
            d => NativePaths.AreEqual(Edit, d.FilePath)
        );
        Assert.Equal(4, view.Edits.Count);
        Assert.Contains(view.Edits, e => (e.StartLine, e.StartCharacter) == at);
        Assert.All(view.Edits, e => Assert.Equal("Heading", e.NewText));
        Assert.DoesNotContain(
            rename.DocumentChanges,
            d => NativePaths.HasExtension(d.FilePath, ".g.cs")
        );

        // The C# inside a `@section` block answers through the projection too.
        var text = await File.ReadAllTextAsync(Index);
        const string section = "\n@section Scripts {\n    <p>@Model.Price</p>\n}\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Index, text + section));
        var line = text.Split('\n').Length + 1;
        var price = RazorFixture.Ok(await manager.GetHoverAsync(Index, line, 17));
        Assert.NotNull(price);
        Assert.Contains("decimal", price.Contents, StringComparison.Ordinal);
        Assert.Contains("Price", price.Contents, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Section_blocks_fold_and_outline()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Index);
        const string section = "\n@section Scripts {\n    <script>var count = 1;</script>\n}\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Index, text + section));
        var opened = text.Split('\n').Length;

        var folds = RazorFixture.Ok(await manager.GetFoldingRangesAsync(Index, default));
        Assert.Contains((opened, opened + 1), folds.Select(fold => (fold.StartLine, fold.EndLine)));
        var symbols = RazorFixture.Ok(await manager.GetDocumentSymbolsAsync(Index, default));
        Assert.Contains(symbols, symbol => symbol.Name == "@section" && symbol.Kind == "Key");
    }

    [Fact]
    public async Task Tag_helper_elements_keep_their_markup_and_blank_their_csharp_values()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Edit, default);
        Assert.NotNull(markup);

        // The elements are HTML, so the HTML projection keeps their tags. [RAZOR-ARCHITECTURE-HTML]
        var html = markup.HtmlText;
        Assert.Contains("<form method=\"post\">", html, StringComparison.Ordinal);
        Assert.Contains("</form>", html, StringComparison.Ordinal);
        Assert.Contains("class=\"form-control\" />", html, StringComparison.Ordinal);
        Assert.Contains(">Reload</a>", html, StringComparison.Ordinal);
        Assert.Contains("<label", html, StringComparison.Ordinal);
        // A tag helper attribute's name and literal value are markup; a model expression and an
        // `@` expression are C#, so only they are blanked, each to its own length.
        Assert.Contains(
            "<input asp-for=\"     \" class=\"form-control\" />",
            html,
            StringComparison.Ordinal
        );
        Assert.Contains(
            "<a asp-page=\"/Edit\" asp-route-id=\"         \">Reload</a>",
            html,
            StringComparison.Ordinal
        );
        Assert.DoesNotContain("Title", html, StringComparison.Ordinal);
        Assert.DoesNotContain("Model", html, StringComparison.Ordinal);

        // Each element a tag helper binds is a tag of the file, with its tag helpers.
        string[] bound = ["form", "label", "input", "span", "a"];
        Assert.All(
            bound,
            name => Assert.Contains(markup.Tags, tag => tag.Name == name && tag.MvcTagHelpers.Any())
        );
    }

    [Fact]
    public async Task Tag_helper_directives_scope_completion_and_binding()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var original = await File.ReadAllTextAsync(Edit);

        // `@removeTagHelper` takes the anchor tag helper out of scope, wherever it is written:
        // anchors stop binding and completing, and the form tag helper stays. [RAZOR-MVC-SCOPE]
        const string anchor =
            "@removeTagHelper Microsoft.AspNetCore.Mvc.TagHelpers.AnchorTagHelper, "
            + "Microsoft.AspNetCore.Mvc.TagHelpers";
        var removed = await EditedAsync(manager, original + "\n" + anchor + "\n<a asp-");
        Assert.DoesNotContain(
            removed.Items,
            item => item.Label.StartsWith("asp-", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(removed.Markup.Tags, tag => tag.Name == "a");
        var form = Assert.Single(removed.Markup.Tags, tag => tag.Name == "form");
        Assert.Contains(
            form.MvcTagHelpers,
            helper => helper.Name.EndsWith(".FormTagHelper", StringComparison.Ordinal)
        );

        // `@tagHelperPrefix` makes only prefixed elements tag helpers: they bind, complete and
        // answer hover under their prefixed name, and unprefixed ones do none of it.
        var prefixed = await EditedAsync(
            manager,
            "@tagHelperPrefix th:\n" + original + "\n<th:a asp-page=\"/Edit\">Go</th:a>\n<th:a asp-"
        );
        Assert.Contains(prefixed.Items, item => item.Label == "asp-route-");
        Assert.DoesNotContain(prefixed.Markup.Tags, tag => tag.Name == "form");
        var go = Assert.Single(prefixed.Markup.Tags, tag => tag.Name == "a");
        Assert.Equal("th:a", prefixed.Markup.Text.ToString(go.StartName));
        Assert.Equal("th:a", prefixed.Markup.Text.ToString(go.EndName!.Value));
        var at = prefixed.Markup.Text.Lines.GetLinePosition(go.StartName.Start + 3);
        var hover = RazorFixture.Ok(await manager.GetHoverAsync(Edit, at.Line, at.Character));
        Assert.NotNull(hover);
        Assert.Contains("AnchorTagHelper", hover.Contents, StringComparison.Ordinal);
        var unprefixed = await EditedAsync(
            manager,
            "@tagHelperPrefix th:\n" + original + "\n<a asp-"
        );
        Assert.DoesNotContain(
            unprefixed.Items,
            item => item.Label.StartsWith("asp-", StringComparison.Ordinal)
        );
    }

    /// <summary>The markup facts and the completion at the end of <paramref name="text"/>, once it is Edit.cshtml's.</summary>
    private async Task<(RazorMarkup Markup, List<CompletionItem> Items)> EditedAsync(
        WorkspaceManager manager,
        string text
    )
    {
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Edit, text));
        var lines = text.Split('\n');
        var items = RazorFixture.Ok(
            await manager.GetCompletionsAsync(Edit, lines.Length - 1, lines[^1].Length)
        );
        var markup = await manager.FindRazorMarkupAsync(Edit, default);
        Assert.NotNull(markup);
        return (markup, items);
    }

    /// <summary>The completion at the end of <paramref name="text"/>, once it is Edit.cshtml's.</summary>
    private async Task<List<CompletionItem>> CompletedAsync(WorkspaceManager manager, string text)
    {
        return (await EditedAsync(manager, text)).Items;
    }

    /// <summary>The text of <paramref name="text"/> that <paramref name="item"/>'s edit replaces.</summary>
    private static string ReplacedText(string text, CompletionItem item)
    {
        Assert.NotNull(item.TextEdit);
        var lines = text.Split('\n');
        Assert.Equal(item.TextEdit.StartLine, item.TextEdit.EndLine);
        return lines[item.TextEdit.StartLine][
            item.TextEdit.StartCharacter..item.TextEdit.EndCharacter
        ];
    }

    private static async Task<string> HoverAsync(
        WorkspaceManager manager,
        string file,
        (int Line, int Character) at,
        int offset = 0
    )
    {
        var hover = RazorFixture.Ok(
            await manager.GetHoverAsync(file, at.Line, at.Character + offset)
        );
        Assert.NotNull(hover);
        return hover.Contents;
    }
}
