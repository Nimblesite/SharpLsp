using MessagePack;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Real IPC coverage of [RAZOR-ARCHITECTURE-ROUTING], [RAZOR-ARCHITECTURE-HTML] and [RAZOR-TESTING].</summary>
public sealed class RazorSidecarTests(CSharpSidecarFixture socket, RazorFixture files)
    : IClassFixture<CSharpSidecarFixture>,
        IClassFixture<RazorFixture>
{
    private string Board => files.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Projection_round_trips_current_text_and_returns_null_for_unlisted_files()
    {
        await OpenAsync().ConfigureAwait(true);
        var before = await AtAsync<HtmlProjectionResult?>("sharplsp/razor/htmlProjection", Board)
            .ConfigureAwait(true);
        Assert.NotNull(before);
        Assert.Contains("<Panel", before.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("@code", before.Text, StringComparison.Ordinal);
        const string changed = "<p>@DateTime.Now</p>\r\n";
        await socket
            .SendAndAssertOkAsync(
                "textDocument/didChange",
                new DidChangeRequest { FilePath = Board, NewText = changed }
            )
            .ConfigureAwait(true);
        var after = await AtAsync<HtmlProjectionResult?>("sharplsp/razor/htmlProjection", Board)
            .ConfigureAwait(true);
        Assert.NotNull(after);
        Assert.Equal("<p>             </p>\r\n", after.Text);
        Assert.Equal(changed.Length, after.Text.Length);
        Assert.Null(
            await AtAsync<HtmlProjectionResult?>(
                    "sharplsp/razor/htmlProjection",
                    files.Path("Missing.razor")
                )
                .ConfigureAwait(true)
        );
    }

    [Theory]
    [InlineData(4, 2, true)]
    [InlineData(4, 14, true)]
    [InlineData(4, 19, false)]
    [InlineData(6, 3, true)]
    [InlineData(6, 8, true)]
    [InlineData(6, 16, true)]
    [InlineData(11, 16, false)]
    [InlineData(22, 24, false)]
    [InlineData(22, 4, false)]
    public async Task Positioned_projection_forwards_markup_but_not_csharp_or_its_whitespace(
        int line,
        int character,
        bool markup
    )
    {
        // The compiler-backed position query decides ownership. [RAZOR-FEATURES-HTML]
        await OpenAsync().ConfigureAwait(true);
        var at = await socket
            .SendAndDeserializeAsync<HtmlProjectionResult?>(
                "sharplsp/razor/htmlProjection",
                MessagePackSerializer.Serialize((Board, new[] { line, character }))
            )
            .ConfigureAwait(true);
        var whole = await AtAsync<HtmlProjectionResult?>("sharplsp/razor/htmlProjection", Board)
            .ConfigureAwait(true);
        Assert.Equal(markup, at is not null);
        Assert.NotNull(whole);
        Assert.Contains("<Panel", whole.Text, StringComparison.Ordinal);
        Assert.Equal(markup ? whole.Text : null, at?.Text);
    }

    [Theory]
    [InlineData("<p>@scores.", "</p>")]
    [InlineData("<p>@(scores.", "")]
    [InlineData("<p>@(scores.MinBy(score => score.", "")]
    [InlineData("<p>@(scores.MinBy(score => { return score.", "")]
    public async Task Incomplete_csharp_keeps_html_forwarding_off(string before, string after)
    {
        // The generator can call a trailing dot markup; completion recovery still owns it.
        // [RAZOR-FEATURES-HTML] [RAZOR-FEATURES-COMPLETION]
        await OpenAsync().ConfigureAwait(true);
        var text = before + after + "\n@code { private readonly List<int> scores = []; }";
        await socket
            .SendAndAssertOkAsync(
                "textDocument/didChange",
                new DidChangeRequest { FilePath = Board, NewText = text }
            )
            .ConfigureAwait(true);
        var at = await socket
            .SendAndDeserializeAsync<HtmlProjectionResult?>(
                "sharplsp/razor/htmlProjection",
                MessagePackSerializer.Serialize((Board, new[] { 0, before.Length }))
            )
            .ConfigureAwait(true);
        Assert.Null(at);
        var whole = await AtAsync<HtmlProjectionResult?>("sharplsp/razor/htmlProjection", Board)
            .ConfigureAwait(true);
        Assert.NotNull(whole);
        Assert.StartsWith("<p>", whole.Text, StringComparison.Ordinal);
        Assert.Equal(text.Length, whole.Text.Length);
    }

    [Fact]
    public async Task Syntax_requests_keep_their_wire_shapes_and_source_ranges()
    {
        await OpenAsync().ConfigureAwait(true);
        var folds = await AtAsync<List<FoldingRangeResult>>("textDocument/foldingRange", Board)
            .ConfigureAwait(true);
        Assert.Equal(
            [(6, 9), (7, 8), (14, 24)],
            folds.Select(fold => (fold.StartLine, fold.EndLine))
        );
        var symbols = await AtAsync<List<DocumentSymbolResult>>(
                "textDocument/documentSymbol",
                Board
            )
            .ConfigureAwait(true);
        Assert.Equal(
            "Tally",
            Assert.Single(symbols.Single(symbol => symbol.Name == "Panel").Children).Name
        );
        Assert.Contains(
            symbols.Single(symbol => symbol.Name == "@code").Children,
            child => child.Name == "Add"
        );
        var linked = await AtAsync<LocationListResult>(
                "textDocument/linkedEditingRange",
                Board,
                6,
                3
            )
            .ConfigureAwait(true);
        Assert.Equal(
            [(6, 1, 6, 6), (10, 2, 10, 7)],
            linked.Locations.Select(at => (at.Line, at.Character, at.EndLine, at.EndCharacter))
        );
        Assert.All(linked.Locations, at => Assert.Equal(Board, at.FilePath));
    }

    [Fact]
    public async Task Selection_ranges_chain_each_caret_out_to_the_document_over_the_socket()
    {
        await OpenAsync().ConfigureAwait(true);

        // One chain per caret, in request order, innermost first. [RAZOR-FEATURES-SELECTION]
        var chains = await socket
            .SendAndDeserializeAsync<SelectionRangeRequest, List<SelectionRangeResult>>(
                "textDocument/selectionRange",
                new SelectionRangeRequest
                {
                    FilePath = Board,
                    Positions =
                    [
                        new SelectionRangePosition { Line = 7, Character = 5 },
                        new SelectionRangePosition { Line = 0, Character = 0 },
                    ],
                }
            )
            .ConfigureAwait(true);
        Assert.Equal(2, chains.Count);
        var tally = chains[0].Ranges;
        Assert.Equal((7, 5, 7, 10), Span(tally[0]));
        Assert.Equal((7, 4, 9, 12), Span(tally[1]));
        Assert.Equal((6, 0, 10, 8), Span(tally[2]));
        Assert.All(chains, chain => Assert.Equal((0, 0, 26, 0), Span(chain.Ranges[^1])));

        // A file no project lists has no chain at all, never an error.
        var unlisted = await socket
            .SendAndDeserializeAsync<SelectionRangeRequest, List<SelectionRangeResult>>(
                "textDocument/selectionRange",
                new SelectionRangeRequest
                {
                    FilePath = files.Path("Missing.razor"),
                    Positions = [new SelectionRangePosition { Line = 0, Character = 0 }],
                }
            )
            .ConfigureAwait(true);
        Assert.Empty(Assert.Single(unlisted).Ranges);
    }

    [Fact]
    public async Task Foreign_references_name_the_razor_uses_of_an_fsharp_symbol_over_the_socket()
    {
        await OpenAsync().ConfigureAwait(true);
        var leaders = files.Path("BlazorApp", "Components", "Pages", "Leaders.razor");

        // The F# sidecar names `Player` by identity; C# answers its three Razor uses.
        // [REFERENCES-CROSS-LANGUAGE]
        var player = await socket
            .SendAndDeserializeAsync<ForeignSymbolRequest, LocationListResult>(
                "workspace/referencesForeign",
                new ForeignSymbolRequest
                {
                    AssemblyName = "Domain",
                    XmlDocSig = "T:Domain.Player",
                    IncludeDeclaration = false,
                }
            )
            .ConfigureAwait(true);
        Assert.Equal(3, player.Locations.Count);
        Assert.All(
            player.Locations,
            location =>
            {
                Assert.True(NativePaths.AreEqual(leaders, location.FilePath), location.FilePath);
                Assert.Equal("Player".Length, location.EndCharacter - location.Character);
            }
        );
        Assert.Contains(
            RazorFixture.Locate(leaders, "private readonly Player[]", "Player"),
            player.Locations.Select(location => (location.Line, location.Character))
        );

        // Another assembly's symbol of that name has no C# use.
        var elsewhere = await socket
            .SendAndDeserializeAsync<ForeignSymbolRequest, LocationListResult>(
                "workspace/referencesForeign",
                new ForeignSymbolRequest
                {
                    AssemblyName = "Elsewhere",
                    XmlDocSig = "T:Domain.Player",
                }
            )
            .ConfigureAwait(true);
        Assert.Empty(elsewhere.Locations);
    }

    [Theory]
    [InlineData("sharplsp/razor/htmlProjection")]
    [InlineData("textDocument/documentSymbol")]
    [InlineData("textDocument/foldingRange")]
    [InlineData("textDocument/linkedEditingRange")]
    [InlineData("textDocument/selectionRange")]
    [InlineData("workspace/referencesForeign")]
    public async Task Malformed_payloads_return_errors_and_keep_the_socket_healthy(string method)
    {
        var error = await socket.SendAsync(method, [0xC1]).ConfigureAwait(true);
        Assert.NotNull(error.Error);
        var pong = await socket.SendAndDeserializeAsync<string>("ping", []).ConfigureAwait(true);
        Assert.Equal("pong", pong);
    }

    private static (int, int, int, int) Span(SelectionSpanResult span)
    {
        return (span.StartLine, span.StartCharacter, span.EndLine, span.EndCharacter);
    }

    private Task OpenAsync()
    {
        return socket.SendAndAssertOkAsync(
            "workspace/open",
            MessagePackSerializer.Serialize(files.SolutionPath)
        );
    }

    private Task<T> AtAsync<T>(string method, string path, int? line = null, int character = 0)
    {
        return line is { } at
            ? socket.SendAndDeserializeAsync<PositionRequest, T>(
                method,
                new PositionRequest
                {
                    FilePath = path,
                    Line = at,
                    Character = character,
                }
            )
            : socket.SendAndDeserializeAsync<T>(
                method,
                MessagePackSerializer.Serialize(new[] { path })
            );
    }
}
