using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Selection ranges of the fixture's real Razor files: every position answers the chain from
/// its innermost C# fragment or markup span out to the whole document, each range strictly
/// holding the one before, all in the Razor file. Implements [RAZOR-TESTING] for
/// [RAZOR-FEATURES-SELECTION].
/// </summary>
public sealed class RazorSelectionRangesTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorSelectionRangesTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Counter => _fixture.Path("BlazorApp", "Components", "Pages", "Counter.razor");

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Edit => _fixture.Path("PagesApp", "Pages", "Edit.cshtml");

    [Fact]
    public async Task Csharp_in_a_code_block_chains_from_the_identifier_to_the_document()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var statement = RazorFixture.Locate(Counter, "currentCount++;", "currentCount");

        // The identifier, its increment, the statement, the method's body and
        // header, the @code directive, and the whole document.
        var at = await RangesAsync(manager, Counter, statement);
        Assert.Equal(
            [
                Span(Counter, "currentCount++;", "currentCount"),
                (16, 8, 16, 22),
                Span(Counter, "currentCount++;", "currentCount++;"),
                (15, 4, 17, 5),
                (14, 4, 17, 5),
                (11, 0, 18, 1),
                Document(Counter),
            ],
            at
        );
        AssertAllContain(at, statement);

        // The method's name selects the method itself, not its body.
        var name = RazorFixture.Locate(Counter, "IncrementCount()", "IncrementCount");
        var header = await RangesAsync(manager, Counter, name);
        Assert.Equal(
            [
                Span(Counter, "IncrementCount()", "IncrementCount"),
                (14, 4, 17, 5),
                (11, 0, 18, 1),
                Document(Counter),
            ],
            header
        );
        AssertAllContain(header, name);

        // The directive's own name selects the whole @code block.
        var directive = RazorFixture.Locate(Counter, "@code {", "@code");
        var block = await RangesAsync(manager, Counter, directive);
        Assert.Equal([(11, 0, 18, 1), Document(Counter)], block);
        AssertAllContain(block, directive);
    }

    [Fact]
    public async Task Component_tags_chain_through_every_enclosing_element()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var tally = RazorFixture.Locate(Board, "<Tally ", "Tally");
        var badge = RazorFixture.Locate(Board, "<Badge ", "Badge");

        // One request for both carets: Badge nests inside Tally inside Panel.
        var both = RazorFixture.Ok(
            await manager.GetSelectionRangesAsync(Board, [tally, badge], default)
        );
        Assert.Equal(2, both.Count);
        Assert.Equal(
            [Span(Board, "<Tally ", "Tally"), (7, 4, 9, 12), (6, 0, 10, 8), Document(Board)],
            Chains(both[0])
        );
        Assert.Equal(
            [
                Span(Board, "<Badge ", "Badge"),
                (8, 8, 8, 33),
                (7, 4, 9, 12),
                (6, 0, 10, 8),
                Document(Board),
            ],
            Chains(both[1])
        );
        AssertAllContain(Chains(both[0]), tally);
        AssertAllContain(Chains(both[1]), badge);
    }

    [Fact]
    public async Task Attribute_names_and_values_chain_through_their_element()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var name = RazorFixture.Locate(Board, "<Panel Title=\"Scores\">", "Title");
        var value = RazorFixture.Locate(Board, "<Panel Title=\"Scores\">", "Scores");

        var atName = await RangesAsync(manager, Board, name);
        Assert.Equal(
            [
                Span(Board, "<Panel Title=\"Scores\">", "Title"),
                Span(Board, "<Panel Title=\"Scores\">", "Title=\"Scores\""),
                (6, 0, 10, 8),
                Document(Board),
            ],
            atName
        );
        AssertAllContain(atName, name);

        // The value selects the whole attribute, which the facts derive from
        // the name's span, then the element and the document.
        var atValue = await RangesAsync(manager, Board, value);
        Assert.Equal(
            [
                Span(Board, "<Panel Title=\"Scores\">", "Title=\"Scores\""),
                (6, 0, 10, 8),
                Document(Board),
            ],
            atValue
        );
        AssertAllContain(atValue, value);
    }

    [Fact]
    public async Task Implicit_expressions_chain_from_csharp_to_their_element()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var expression = RazorFixture.Locate(
            Counter,
            "Current count: @currentCount",
            "currentCount"
        );

        var at = await RangesAsync(manager, Counter, expression);
        Assert.Equal([(7, 33, 7, 45), (7, 0, 7, 49), Document(Counter)], at);
        AssertAllContain(at, expression);
    }

    [Fact]
    public async Task Plain_html_of_a_legacy_file_selects_its_elements_or_only_the_document()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var form = RazorFixture.Locate(Edit, "<form method=\"post\">", "form");
        var page = RazorFixture.Locate(Edit, "@page \"{id:int}\"", "@page");

        // One request for both carets: the form element answers its name and
        // its element, and the @page directive answers itself, then the file.
        var both = RazorFixture.Ok(
            await manager.GetSelectionRangesAsync(Edit, [form, page], default)
        );
        Assert.Equal(2, both.Count);
        Assert.Equal(
            [Span(Edit, "<form method=\"post\">", "form"), (4, 0, 9, 7), Document(Edit)],
            Chains(both[0])
        );
        AssertAllContain(Chains(both[0]), form);

        var atPage = Chains(both[1]);
        Assert.Equal(2, atPage.Count);
        Assert.Equal((0, 0, 1, 0), atPage[0]);
        Assert.Equal(Document(Edit), atPage[1]);
        AssertAllContain(atPage, page);

        // A position no markup fact holds — the blank line between the
        // directives and the form — selects only the document.
        var blank = await RangesAsync(manager, Edit, (3, 0));
        Assert.Equal([Document(Edit)], blank);
    }

    [Fact]
    public async Task A_file_no_project_lists_answers_empty()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var missing = _fixture.Path("BlazorApp", "Components", "Pages", "Missing.razor");

        var answer = RazorFixture.Ok(
            await manager.GetSelectionRangesAsync(missing, [(0, 1), (18, 0)], default)
        );
        Assert.Equal(2, answer.Count);
        Assert.Empty(answer[0].Ranges);
        Assert.Empty(answer[1].Ranges);

        // A plain C# file is not Razor; the sidecar answers empty for it too.
        var program = _fixture.Path("BlazorApp", "Program.cs");
        var csharp = RazorFixture.Ok(
            await manager.GetSelectionRangesAsync(program, [(0, 1)], default)
        );
        Assert.Empty(csharp[0].Ranges);

        // A cancelled request is a failure the host reports, never a partial answer.
        var cancelled = await manager.GetSelectionRangesAsync(
            _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor"),
            [(0, 1)],
            new CancellationToken(true)
        );
        Assert.True(cancelled.IsError, "a cancelled request fails");
    }

    /// <summary>The selection ranges at one position, as (line, character) tuples.</summary>
    private static async Task<
        List<(int StartLine, int StartCharacter, int EndLine, int EndCharacter)>
    > RangesAsync(WorkspaceManager manager, string file, (int Line, int Character) at)
    {
        var answer = RazorFixture.Ok(await manager.GetSelectionRangesAsync(file, [at], default));
        return Chains(Assert.Single(answer));
    }

    /// <summary>One position's ranges, innermost first, as (line, character) tuples.</summary>
    private static List<(int, int, int, int)> Chains(SelectionRangeResult ranges)
    {
        return
        [
            .. ranges.Ranges.Select(range =>
                (range.StartLine, range.StartCharacter, range.EndLine, range.EndCharacter)
            ),
        ];
    }

    /// <summary>The (line, character) span of <paramref name="token"/> on the line holding <paramref name="anchor"/>.</summary>
    private static (int StartLine, int StartCharacter, int EndLine, int EndCharacter) Span(
        string file,
        string anchor,
        string token
    )
    {
        var (line, character) = RazorFixture.Locate(file, anchor, token);
        return (line, character, line, character + token.Length);
    }

    /// <summary>The whole file's span: from the first character to past the last line break.</summary>
    private static (int, int, int, int) Document(string file)
    {
        var text = System.IO.File.ReadAllText(file);
        var lines = text.Split('\n');
        return text.EndsWith('\n')
            ? (0, 0, lines.Length - 1, 0)
            : (0, 0, lines.Length - 1, lines[^1].Length);
    }

    /// <summary>Every range of the chain holds the caret and holds every range before it.</summary>
    private static void AssertAllContain(
        List<(int StartLine, int StartCharacter, int EndLine, int EndCharacter)> chain,
        (int Line, int Character) at
    )
    {
        Assert.NotEmpty(chain);
        Assert.True(
            chain[0].StartLine < at.Line
                || (chain[0].StartLine == at.Line && chain[0].StartCharacter <= at.Character),
            $"the innermost range starts after the caret: {chain[0]}"
        );
        for (var index = 1; index < chain.Count; index++)
        {
            Assert.True(
                Holds(chain[index - 1], chain[index]),
                $"range {index - 1} must sit inside range {index}: {chain[index - 1]} vs {chain[index]}"
            );
        }
    }

    /// <summary>Whether <paramref name="outer"/> holds <paramref name="inner"/>.</summary>
    private static bool Holds(
        (int StartLine, int StartCharacter, int EndLine, int EndCharacter) inner,
        (int StartLine, int StartCharacter, int EndLine, int EndCharacter) outer
    )
    {
        var startsInside =
            outer.StartLine < inner.StartLine
            || (outer.StartLine == inner.StartLine && outer.StartCharacter <= inner.StartCharacter);
        var endsInside =
            outer.EndLine > inner.EndLine
            || (outer.EndLine == inner.EndLine && outer.EndCharacter >= inner.EndCharacter);
        return startsInside && endsInside;
    }
}
