#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Incomplete expressions keep member completion. [RAZOR-FEATURES-COMPLETION]</summary>
public sealed class RazorCompletionRecoveryTests(RazorFixture fixture) : IClassFixture<RazorFixture>
{
    private string Board => fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Theory]
    [InlineData("<p>@scores.</p>", 11)]
    [InlineData("<p>@(scores.", 12)]
    [InlineData("<p>@(scores.)</p>", 12)]
    [InlineData("<p>@{ var n = scores.", 21)]
    public async Task Completion_after_a_dot_offers_collection_members(string markup, int character)
    {
        // Incomplete expressions still need completion before a member name is typed.
        // [RAZOR-FEATURES-COMPLETION]
        using var manager = await fixture.OpenManagerAsync();
        const string members = "\n@code { private readonly List<int> scores = []; }";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, markup + members));
        var items = RazorFixture.Ok(await manager.GetCompletionsAsync(Board, 0, character));
        var count = Assert.Single(items, item => item.Label == "Count" && item.Kind == "Property");
        Assert.Contains(items, item => item.Label == "Add");
        Assert.NotNull(count.TextEdit);
        Assert.Equal((0, character), (count.TextEdit.StartLine, count.TextEdit.StartCharacter));
        Assert.Equal(character, count.TextEdit.EndCharacter);
    }

    [Theory]
    [InlineData("<p>Cheapest: @(basket.MinBy(product => product.", "")]
    [InlineData("<p>Cheapest: @(basket.MinBy(product => product.Pr", "")]
    [InlineData("<p>Cheapest: @(basket.MinBy(product => product.", ")</p>")]
    [InlineData("<p>Cheapest: @(basket.MinBy(product => product.", "))</p>")]
    [InlineData("<p>First: @(new[] { basket[0].", "")]
    [InlineData("@{ var cheapest = basket.MinBy(product => product.", " }")]
    public async Task Completion_inside_a_call_in_an_unfinished_expression_offers_members(
        string before,
        string after
    )
    {
        // A call or lambda inside an @( missing its ) completes too (#404), with its edit at
        // the caret of a file whose fragments before and after the caret still map.
        // [RAZOR-FEATURES-COMPLETION]
        using var manager = await fixture.OpenManagerAsync();
        const string heading = "<h1>@basket.Count</h1>\n";
        const string code =
            "\n@code { private readonly List<Product> basket = []; "
            + "private sealed record Product(string Name, decimal Price); }";
        _ = RazorFixture.Ok(
            await manager.UpdateDocumentTextAsync(Board, heading + before + after + code)
        );
        var items = RazorFixture.Ok(await manager.GetCompletionsAsync(Board, 1, before.Length));
        var price = Assert.Single(items, item => item.Label == "Price" && item.Kind == "Property");
        Assert.Contains(items, item => item.Label == "Name" && item.Kind == "Property");
        Assert.NotNull(price.TextEdit);
        var member = before.LastIndexOf('.') + 1;
        Assert.Equal(
            (1, member, 1, before.Length),
            (
                price.TextEdit.StartLine,
                price.TextEdit.StartCharacter,
                price.TextEdit.EndLine,
                price.TextEdit.EndCharacter
            )
        );
    }

    [Fact]
    public async Task Completion_in_an_unclosed_block_replaces_what_was_typed_before_the_caret()
    {
        // The copy closes the expression after the caret, so an edit still spans the member
        // prefix typed before it. [RAZOR-FEATURES-COMPLETION]
        using var manager = await fixture.OpenManagerAsync();
        const string members = "\n@code { private readonly List<int> scores = []; }";
        _ = RazorFixture.Ok(
            await manager.UpdateDocumentTextAsync(Board, "<p>@(scores.Co" + members)
        );
        var typed = RazorFixture.Ok(await manager.GetCompletionsAsync(Board, 0, 14));
        var count = Assert.Single(typed, item => item.Label == "Count" && item.Kind == "Property");
        Assert.NotNull(count.TextEdit);
        Assert.Equal(
            (0, 12, 0, 14),
            (
                count.TextEdit.StartLine,
                count.TextEdit.StartCharacter,
                count.TextEdit.EndLine,
                count.TextEdit.EndCharacter
            )
        );

        // An @code block that is missing its close keeps member completion too.
        const string block =
            "<p>x</p>\n@code { private readonly List<int> scores = []; void Score() { scores.";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, block));
        var caret = block.Split('\n')[1].Length;
        var inBlock = RazorFixture.Ok(await manager.GetCompletionsAsync(Board, 1, caret));
        var blockCount = Assert.Single(
            inBlock,
            item => item.Label == "Count" && item.Kind == "Property"
        );
        Assert.Contains(inBlock, item => item.Label == "Add");
        Assert.NotNull(blockCount.TextEdit);
        Assert.Equal(
            (1, caret, caret),
            (
                blockCount.TextEdit.StartLine,
                blockCount.TextEdit.StartCharacter,
                blockCount.TextEdit.EndCharacter
            )
        );
    }
}
