using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Completion in Blazor markup, against the real fixture solution: components after
/// <c>&lt;</c>, child-content parameters inside a component, and in a start tag the
/// parameters not yet set (<c>[EditorRequired]</c> first), <c>@bind-X</c> and the directive
/// attributes with their parameters. Every item replaces the name typed at the caret.
/// Implements [RAZOR-TESTING] for [RAZOR-FEATURES-COMPLETION].
/// </summary>
public sealed class RazorMarkupCompletionTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupCompletionTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task After_a_tag_open_components_complete_by_short_or_full_name()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (items, at) = await CompleteAfterAsync(manager, "\n<Ba");

        // In scope by short name: imported, this namespace, and its parent namespace.
        Assert.Contains(items, item => item.Label == "Badge");
        Assert.Contains(items, item => item.Label == "Panel");
        Assert.Contains(items, item => item.Label == "Counter");
        Assert.Contains(items, item => item.Label == "Routes");
        // Not imported: by its full name, never its short one.
        Assert.Contains(
            items,
            item => item.Label == "Microsoft.AspNetCore.Components.Web.Virtualization.Virtualize"
        );
        Assert.DoesNotContain(items, item => item.Label == "Virtualize");

        var badge = Assert.Single(items, item => item.Label == "Badge");
        Assert.Equal("Class", badge.Kind);
        Assert.Contains(
            "A small label beside a tally.",
            badge.Documentation,
            StringComparison.Ordinal
        );
        Assert.NotNull(badge.TextEdit);
        Assert.Equal((at.Line, at.Character - 2, at.Character), Replaced(badge));
        Assert.Equal("Badge", badge.TextEdit.NewText);
    }

    [Fact]
    public async Task Inside_a_component_its_child_content_parameters_complete()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Board);
        var edited = text.Replace(
            "<Panel Title=\"Scores\">",
            "<Panel Title=\"Scores\">\n    <",
            StringComparison.Ordinal
        );
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, edited));
        var caret = Position(
            edited,
            edited.IndexOf("Scores\">\n    <", StringComparison.Ordinal) + "Scores\">\n    <".Length
        );

        var items = RazorFixture.Ok(
            await manager.GetCompletionsAsync(Board, caret.Line, caret.Character)
        );

        var content = Assert.Single(items, item => item.Label == "ChildContent");
        Assert.Equal("Property", content.Kind);
        Assert.Contains(items, item => item.Label == "Badge");
    }

    [Fact]
    public async Task A_component_start_tag_offers_unset_parameters_required_first_then_bind_and_directives()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (items, _) = await CompleteAfterAsync(manager, "\n<Tally ");

        var ordered = items.OrderBy(item => item.SortText, StringComparer.Ordinal).ToList();
        var first = ordered[0];
        Assert.Equal("Items", first.Label);
        Assert.Contains("required", first.Detail, StringComparison.Ordinal);
        Assert.Contains(items, item => item.Label == "Format" && item.Kind == "Property");
        Assert.DoesNotContain(
            items.Where(item => item != first),
            item => item.Detail?.Contains("required", StringComparison.Ordinal) == true
        );
        Assert.Contains(items, item => item.Label == "@bind-Label");
        Assert.Contains(items, item => item.Label == "@key");
        Assert.Contains(items, item => item.Label == "@ref");
    }

    [Fact]
    public async Task An_element_start_tag_offers_directive_attributes_and_their_parameters()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (items, _) = await CompleteAfterAsync(manager, "\n<input @");

        string[] expected =
        [
            "@onclick",
            "@bind",
            "@bind-value",
            "@key",
            "@ref",
            "@attributes",
            "@bind:event",
            "@onclick:preventDefault",
        ];
        Assert.All(expected, name => Assert.Contains(items, item => item.Label == name));
        Assert.DoesNotContain(items, item => item.Label == "Badge");
    }

    [Fact]
    public async Task An_at_sign_starting_a_markup_line_offers_the_files_directives()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);
        var (items, at) = await CompleteAfterAsync(manager, "\n    @pa");

        // Every directive the parser offers a component, each replacing what was typed.
        Assert.All(
            markup.AvailableDirectives,
            directive => Assert.Contains(items, item => item.Label == "@" + directive.Directive)
        );
        var page = Assert.Single(items, item => item.Label == "@page");
        Assert.Equal("Keyword", page.Kind);
        Assert.Equal((at.Line, at.Character - 3, at.Character), Replaced(page));
        Assert.False(string.IsNullOrEmpty(page.Documentation));

        // Mid-line, `@` starts C#, not a directive.
        var (inline, _) = await CompleteAfterAsync(manager, "\n<p>@pa");
        Assert.DoesNotContain(inline, item => item.Label == "@page");
    }

    /// <summary>Completion at the end of <paramref name="suffix"/>, appended to Board's text.</summary>
    private async Task<(
        List<CompletionItem> Items,
        (int Line, int Character) At
    )> CompleteAfterAsync(WorkspaceManager manager, string suffix)
    {
        var text = await File.ReadAllTextAsync(Board) + suffix;
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, text));
        var at = Position(text, text.Length);
        return (
            RazorFixture.Ok(await manager.GetCompletionsAsync(Board, at.Line, at.Character)),
            at
        );
    }

    private static (int Line, int Character) Position(string text, int offset)
    {
        var before = text[..offset];
        var line = before.Count(c => c == '\n');
        return (line, offset - (before.LastIndexOf('\n') + 1));
    }

    private static (int, int, int) Replaced(CompletionItem item)
    {
        Assert.NotNull(item.TextEdit);
        Assert.Equal(item.TextEdit.StartLine, item.TextEdit.EndLine);
        return (item.TextEdit.StartLine, item.TextEdit.StartCharacter, item.TextEdit.EndCharacter);
    }
}
