using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Collocated files of a Razor file, against the real fixture solution: the class selectors of
/// <c>Card.razor.css</c> complete inside a <c>class</c> value and define to every selector that
/// declares them, and a <c>InvokeAsync&lt;IJSObjectReference&gt;("import", "…")</c> call defines
/// to the start of the <c>Card.razor.js</c> it names, from Razor, a code-behind and plain C#.
/// Implements [RAZOR-TESTING] for [RAZOR-COLLOCATION].
/// </summary>
public sealed class RazorCollocationTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorCollocationTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Card => _fixture.Path("BlazorApp", "Components", "Shared", "Card.razor");

    private string Stylesheet =>
        _fixture.Path("BlazorApp", "Components", "Shared", "Card.razor.css");

    private string Module => _fixture.Path("BlazorApp", "Components", "Shared", "Card.razor.js");

    private string CodeBehind =>
        _fixture.Path("BlazorApp", "Components", "Shared", "Card.razor.cs");

    private string Interop => _fixture.Path("BlazorApp", "Components", "Shared", "CardInterop.cs");

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    /// <summary>Text of the stylesheet that is not a class selector.</summary>
    private static readonly string[] NotClasses =
    [
        "commented",
        "alsoCommented",
        "zone",
        "rem",
        "pdf",
        "png",
        "a",
        "b",
    ];

    [Fact]
    public async Task Class_completion_offers_each_stylesheet_class_once()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (items, at) = await CompleteAfterAsync(manager, Card, "\n<div class=\"card ti");

        // Every class the stylesheet declares, offered once, as a value of that stylesheet.
        var title = Assert.Single(items, item => item.Label == "title");
        Assert.Equal("Value", title.Kind);
        Assert.Equal("Card.razor.css", title.Detail);
        Assert.NotNull(title.TextEdit);
        Assert.Equal(at.Line, title.TextEdit.StartLine);
        Assert.Equal(at.Character - 2, title.TextEdit.StartCharacter);
        Assert.Equal(at.Character, title.TextEdit.EndCharacter);
        Assert.Equal("title", title.TextEdit.NewText);

        // Declared inside at-rules, `:is()` and `::deep`, they all complete.
        Assert.Contains(items, item => item.Label == "card__title");
        Assert.Contains(items, item => item.Label == "accent");
        Assert.Contains(items, item => item.Label == "muted");
        Assert.Contains(items, item => item.Label == "card--grid");
        Assert.Contains(items, item => item.Label == "meta");

        // Never text that is not a class selector: a comment, a declaration value, a number,
        // a string or a url.
        Assert.DoesNotContain(
            items,
            item => item.Kind == "Value" && NotClasses.Contains(item.Label, StringComparer.Ordinal)
        );

        // A class after a bare attribute, single-quoted, still completes the class at the caret.
        var (after, end) = await CompleteAfterAsync(manager, Card, "\n<span hidden class='card mu");
        var muted = Assert.Single(after, item => item.Label == "muted");
        Assert.Equal("Value", muted.Kind);
        Assert.NotNull(muted.TextEdit);
        Assert.Equal(
            (end.Line, end.Character - 2, end.Character),
            (muted.TextEdit.StartLine, muted.TextEdit.StartCharacter, muted.TextEdit.EndCharacter)
        );
        _ = Assert.Single(after, item => item.Label == "title");
    }

    [Fact]
    public async Task Class_definition_lands_on_every_selector_that_declares_it()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var inValue = RazorFixture.Locate(Card, "class=\"card title\"", "title");

        // `.title` is a selector in five rules: alone, compound, deep, attribute-scoped and
        // inside an at-rule.
        var found = RazorFixture.Ok(
            await manager.GetDefinitionAsync(Card, inValue.Line, inValue.Character + 2)
        );
        Assert.Equal(5, found.Locations.Count);
        Assert.All(
            found.Locations,
            location =>
                Assert.True(NativePaths.AreEqual(Stylesheet, location.FilePath), location.FilePath)
        );
        var lines = await File.ReadAllLinesAsync(Stylesheet);
        Assert.All(found.Locations, location => Assert.Equal("title", TextAt(lines, location)));
        Assert.Equal(
            5,
            found.Locations.DistinctBy(location => (location.Line, location.Character)).Count()
        );

        // A class declared by one selector defines once, on the name after its `.`.
        var single = RazorFixture.Locate(Card, "class=\"card__title\"", "card__title");
        var deep = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Card, single.Line, single.Character + 3))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Stylesheet, deep.FilePath), deep.FilePath);
        Assert.Equal("card__title", TextAt(lines, deep));
    }

    [Fact]
    public async Task Module_definition_lands_at_the_start_of_the_module_from_razor_code_behind_and_csharp()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // From the component's `@code` block.
        var razor = RazorFixture.Locate(Card, "./Components/Shared/Card.razor.js", "./Components");
        var code = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Card, razor.Line, razor.Character + 4))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Module, code.FilePath), code.FilePath);
        Assert.Equal((0, 0, 0, 0), (code.Line, code.Character, code.EndLine, code.EndCharacter));

        // From the code-behind half of the component.
        var behind = RazorFixture.Locate(
            CodeBehind,
            "(\"import\", \"./Components/Shared/Card.razor.js\")",
            "./Components"
        );
        var partial = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(CodeBehind, behind.Line, behind.Character + 4))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Module, partial.FilePath), partial.FilePath);

        // From a plain C# file.
        var plain = RazorFixture.Locate(
            Interop,
            "(\"import\", \"./Components/Shared/Card.razor.js\")",
            "./Components"
        );
        var csharp = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Interop, plain.Line, plain.Character + 4))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Module, csharp.FilePath), csharp.FilePath);
        Assert.Equal((0, 0), (csharp.Line, csharp.Character));

        // The first argument must be the constant "import", and the second a constant path.
        var argument = RazorFixture.Locate(CodeBehind, "(\"import\", path)", "path");
        Assert.DoesNotContain(
            RazorFixture
                .Ok(
                    await manager.GetDefinitionAsync(
                        CodeBehind,
                        argument.Line,
                        argument.Character + 2
                    )
                )
                .Locations,
            location => NativePaths.AreEqual(Module, location.FilePath)
        );
        var identifier = RazorFixture.Locate(
            CodeBehind,
            "return js.InvokeAsync<bool>(identifier",
            "./Components"
        );
        Assert.DoesNotContain(
            RazorFixture
                .Ok(
                    await manager.GetDefinitionAsync(
                        CodeBehind,
                        identifier.Line,
                        identifier.Character + 4
                    )
                )
                .Locations,
            location => NativePaths.AreEqual(Module, location.FilePath)
        );
    }

    [Fact]
    public async Task Nothing_is_offered_outside_a_class_value()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // On an attribute's name no class completes.
        var (named, _) = await CompleteAfterAsync(manager, Card, "\n<div cla");
        Assert.DoesNotContain(named, item => item.Kind == "Value");

        // In content, neither completes nor defines.
        var (content, _) = await CompleteAfterAsync(manager, Card, "\n<div>title</div>");
        Assert.DoesNotContain(content, item => item.Kind == "Value");
        var name = RazorFixture.Locate(Card, "class=\"card title\"", "class");
        Assert.Empty(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Card, name.Line, name.Character + 2))
                .Locations
        );
    }

    [Fact]
    public async Task A_component_without_a_stylesheet_offers_and_defines_nothing()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Board.razor has no Board.razor.css, so its class values offer nothing.
        var (items, _) = await CompleteAfterAsync(manager, Board, "\n<span class=\"cart ti");
        Assert.DoesNotContain(items, item => item.Kind == "Value");

        // Nor does anything define.
        var text = await File.ReadAllTextAsync(Board) + "\n<span class=\"card\">";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, text));
        var caret = Position(text, text.Length - 3);
        Assert.Empty(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Board, caret.Line, caret.Character))
                .Locations
        );

        // A Razor file no project lists has no stylesheet to define into, and no error.
        var missing = _fixture.Path("BlazorApp", "Components", "Pages", "Missing.razor");
        Assert.Empty(RazorFixture.Ok(await manager.GetDefinitionAsync(missing, 0, 1)).Locations);
    }

    [Fact]
    public void Collocated_files_are_named_after_the_razor_file()
    {
        Assert.Equal("/app/Card.razor.css", NativePaths.StylesheetOf("/app/Card.razor"));
        Assert.Equal("/app/Index.cshtml.css", NativePaths.StylesheetOf("/app/Index.cshtml"));

        // A module is spelled relative to the app's base path, which is the project directory,
        // and only a collocated module is one.
        Assert.Equal(
            "/app/Components/Shared/Card.razor.js",
            RazorCollocation.ModuleFile("/app", "./Components/Shared/Card.razor.js")
        );
        Assert.Equal(
            "/app/Pages/Index.cshtml.js",
            RazorCollocation.ModuleFile("/app", "/Pages/Index.cshtml.js")
        );
        Assert.Null(RazorCollocation.ModuleFile("/app", "./js/site.js"));
        Assert.Null(RazorCollocation.ModuleFile("/app", "./Components/Shared/Card.razor.css"));
        Assert.Null(RazorCollocation.ModuleFile("/app", "import"));
    }

    /// <summary>Completion at the end of <paramref name="suffix"/>, appended to <paramref name="file"/>'s text.</summary>
    private static async Task<(
        List<CompletionItem> Items,
        (int Line, int Character) At
    )> CompleteAfterAsync(
        SharpLsp.Sidecar.CSharp.Workspace.WorkspaceManager manager,
        string file,
        string suffix
    )
    {
        var text = await File.ReadAllTextAsync(file) + suffix;
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(file, text));
        var at = Position(text, text.Length);
        return (
            RazorFixture.Ok(await manager.GetCompletionsAsync(file, at.Line, at.Character)),
            at
        );
    }

    /// <summary>The position of <paramref name="offset"/> in <paramref name="text"/>.</summary>
    private static (int Line, int Character) Position(string text, int offset)
    {
        var before = text.AsSpan(0, offset);
        return (before.Count('\n'), offset - (text.LastIndexOf('\n', Math.Max(0, offset - 1)) + 1));
    }

    private static string TextAt(string[] lines, LocationResult location)
    {
        return lines[location.Line][location.Character..location.EndCharacter];
    }
}
