#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Inlay hints and code lenses of Razor files, against the real fixture solution: the hints of
/// the C# fragments the requested Razor lines hold, placed in the file, and the reference counts
/// of the members the file declares in <c>@code</c> and <c>@functions</c>. Implements
/// [RAZOR-TESTING] for [RAZOR-FEATURES-INLAY-HINTS] and [RAZOR-FEATURES-CODE-LENS].
/// </summary>
public sealed class RazorHintsAndLensesTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorHintsAndLensesTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Counter => _fixture.Path("BlazorApp", "Components", "Pages", "Counter.razor");

    private string Ticker => _fixture.Path("BlazorApp", "Components", "Shared", "Ticker.razor");

    private string Edit => _fixture.Path("PagesApp", "Pages", "Edit.cshtml");

    [Fact]
    public async Task Inlay_hints_land_at_their_razor_positions()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Board's markup holds a lambda and its @code a call: both keep their parameter names.
        var hints = RazorFixture.Ok(await manager.GetInlayHintsAsync(Board, 0, 25));
        var typed = Assert.Single(hints, hint => hint.Label == ": int");
        Assert.Equal(
            RazorFixture.Locate(Board, "Format=\"@(score", "score =>", "score".Length),
            (typed.Line, typed.Character)
        );
        Assert.Equal(1, typed.Kind);
        Assert.StartsWith(" =>", TextAfter(Board, typed), StringComparison.Ordinal);

        var scored = Assert.Single(hints, hint => hint.Label == "score:");
        Assert.Equal(
            RazorFixture.Locate(Board, "@onclick=\"() => Add(1)\"", "1)"),
            (scored.Line, scored.Character)
        );
        Assert.Equal(2, scored.Kind);
        Assert.StartsWith("1)", TextAfter(Board, scored), StringComparison.Ordinal);

        var listed = Assert.Single(hints, hint => hint.Label == "item:");
        Assert.Equal(
            RazorFixture.Locate(Board, "private void Add", "score + Id"),
            (listed.Line, listed.Character)
        );
        Assert.StartsWith("score + Id", TextAfter(Board, listed), StringComparison.Ordinal);

        // The generated builder's own arguments are hidden scaffolding, never hints of the file.
        Assert.DoesNotContain(hints, hint => hint.Label == "sequence:");
        Assert.DoesNotContain(hints, hint => hint.Label == "markupContent:");

        // A single @code line answers that line alone, and a line outside every fragment none.
        var code = RazorFixture.Ok(await manager.GetInlayHintsAsync(Ticker, 10, 10));
        (int Line, int Character, string Label)[] expected = [(10, 33, "by:"), (10, 11, ": int")];
        Assert.Equal(expected, code.Select(hint => (hint.Line, hint.Character, hint.Label)));
        Assert.Empty(RazorFixture.Ok(await manager.GetInlayHintsAsync(Ticker, 4, 4)));
        Assert.Empty(RazorFixture.Ok(await manager.GetInlayHintsAsync(Board, 3, 3)));
    }

    [Fact]
    public async Task Code_lenses_count_the_razor_uses_of_the_files_members()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Counter declares one member in @code and its markup clicks it: one reference.
        var counter = Assert.Single(RazorFixture.Ok(await manager.GetCodeLensesAsync(Counter)));
        Assert.Equal(
            RazorFixture.Locate(Counter, "private void IncrementCount", "private"),
            (counter.Line, counter.Character)
        );
        Assert.Equal("1 reference", counter.Title);

        // Board's @code holds three members: the parameter its markup reads, the method its
        // button calls, and the interface's method nothing calls by name.
        var board = RazorFixture.Ok(await manager.GetCodeLensesAsync(Board));
        ((int, int), string)[] expected =
        [
            (
                RazorFixture.Locate(Board, "[Parameter] public int Id", "[Parameter]"),
                "2 references"
            ),
            (RazorFixture.Locate(Board, "private void Add", "private"), "1 reference"),
            (RazorFixture.Locate(Board, "public void Dispose", "public"), "0 references"),
        ];
        Assert.Equal(expected, board.Select(lens => ((lens.Line, lens.Character), lens.Title)));

        // A Razor Page's @functions block is lensed the same way, and nothing else in the file is.
        var functions = Assert.Single(RazorFixture.Ok(await manager.GetCodeLensesAsync(Edit)));
        Assert.Equal(
            RazorFixture.Locate(Edit, "string Shout(string text)", "string"),
            (functions.Line, functions.Character)
        );
        Assert.Equal("1 reference", functions.Title);

        // A component with no @code has no lens at all: its class is not a declaration in the file.
        Assert.Empty(
            RazorFixture.Ok(
                await manager.GetCodeLensesAsync(
                    _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor")
                )
            )
        );

        // A code-behind file keeps the lenses C# gives it.
        string[] counts = ["2 references", "2 references"];
        Assert.Equal(
            counts,
            RazorFixture
                .Ok(
                    await manager.GetCodeLensesAsync(
                        _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor.cs")
                    )
                )
                .Select(lens => lens.Title)
        );
    }

    /// <summary>The file's text from <paramref name="hint"/> to the end of its line.</summary>
    private static string TextAfter(string file, InlayHintResult hint)
    {
        return File.ReadAllLines(file)[hint.Line][hint.Character..];
    }
}
