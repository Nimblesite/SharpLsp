#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite

using static SharpLsp.Sidecar.CSharp.Tests.RazorFixture;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Folding, outline and linked tag names for the fixture's real Razor files, the syntax
/// requests the host forwards. Implements [RAZOR-TESTING] for [RAZOR-ARCHITECTURE-ROUTING]
/// and [RAZOR-FEATURES-STRUCTURE].
/// </summary>
public sealed class RazorStructureTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorStructureTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Multi_line_elements_and_the_code_block_fold_keeping_their_last_line()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var folds = Ok(await manager.GetFoldingRangesAsync(Board, default));
        Assert.Equal(
            [(6, 9), (7, 8), (14, 24)],
            folds.Select(fold => (fold.StartLine, fold.EndLine))
        );

        var text = await File.ReadAllTextAsync(Board);
        var grown = text.Replace("</Tally>", "</Tally>\n\n", StringComparison.Ordinal);
        _ = Ok(await manager.UpdateDocumentTextAsync(Board, grown));
        var edited = Ok(await manager.GetFoldingRangesAsync(Board, default));
        Assert.Equal(
            [(6, 11), (7, 8), (16, 26)],
            edited.Select(fold => (fold.StartLine, fold.EndLine))
        );
        var outside = _fixture.Path("BlazorApp", "Program.cs");
        Assert.Empty(Ok(await manager.GetFoldingRangesAsync(outside, default)));
    }

    [Fact]
    public async Task Outline_nests_components_in_markup_and_members_in_their_directives()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var symbols = Ok(await manager.GetDocumentSymbolsAsync(Board, default));
        Assert.Equal(
            ["@page", "@implements", "@inject", "PageTitle", "Panel", "input", "button", "@code"],
            symbols.Select(symbol => symbol.Name)
        );

        var inject = symbols.Single(symbol => symbol.Name == "@inject");
        var navigation = Assert.Single(inject.Children);
        Assert.Equal(
            ("Navigation", "Property", 2),
            (navigation.Name, navigation.Kind, navigation.SelectionStartLine)
        );

        var panel = symbols.Single(symbol => symbol.Name == "Panel");
        Assert.Equal(
            ("Class", 6, 1, 10, 8),
            (
                panel.Kind,
                panel.StartLine,
                panel.SelectionStartCharacter,
                panel.EndLine,
                panel.EndCharacter
            )
        );
        var tally = Assert.Single(panel.Children);
        Assert.Equal("Tally", tally.Name);
        Assert.Equal("Badge", Assert.Single(tally.Children).Name);

        var code = symbols.Single(symbol => symbol.Name == "@code");
        Assert.Equal(
            ("Key", 14, 1, 14, 5),
            (
                code.Kind,
                code.SelectionStartLine,
                code.SelectionStartCharacter,
                code.SelectionEndLine,
                code.SelectionEndCharacter
            )
        );
        Assert.Equal(
            [
                ("Id", "Property"),
                ("scores", "Field"),
                ("caption", "Field"),
                ("tally", "Field"),
                ("Add", "Method"),
                ("Dispose", "Method"),
            ],
            code.Children.Select(member => (member.Name, member.Kind))
        );
        var add = code.Children.Single(member => member.Name == "Add");
        Assert.Equal(
            (22, 4, 22, 17, 22),
            (
                add.StartLine,
                add.StartCharacter,
                add.SelectionStartLine,
                add.SelectionStartCharacter,
                add.SelectionEndLine
            )
        );
    }

    [Fact]
    public async Task Code_blocks_and_functions_blocks_fold_and_outline_their_members()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Board);
        const string blocks =
            "\n@{\n    var total = scores.Sum();\n}\n@functions {\n    private int Twice(int value) => value * 2;\n}\n";
        _ = Ok(await manager.UpdateDocumentTextAsync(Board, text + blocks));
        var opened = text.Split('\n').Length;

        // `@{` opens on the line after the file's end; `@functions` three lines on. Each fold
        // keeps its closing brace visible.
        var folds = Ok(await manager.GetFoldingRangesAsync(Board, default));
        Assert.Contains((opened, opened + 1), folds.Select(fold => (fold.StartLine, fold.EndLine)));
        Assert.Contains(
            (opened + 3, opened + 4),
            folds.Select(fold => (fold.StartLine, fold.EndLine))
        );

        var symbols = Ok(await manager.GetDocumentSymbolsAsync(Board, default));
        var functions = Assert.Single(symbols, symbol => symbol.Name == "@functions");
        Assert.Equal("Key", functions.Kind);
        Assert.Equal(
            ("Twice", "Method"),
            (Assert.Single(functions.Children).Name, functions.Children[0].Kind)
        );
    }

    [Fact]
    public async Task Start_and_end_tag_names_edit_together_and_self_closing_tags_have_none()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var panel = Ok(await manager.GetLinkedEditingRangesAsync(Board, (6, 3), default));
        Assert.Equal(
            [(6, 1, 6, 6), (10, 2, 10, 7)],
            panel.Locations.Select(range =>
                (range.Line, range.Character, range.EndLine, range.EndCharacter)
            )
        );
        Assert.All(panel.Locations, range => Assert.Equal(Board, range.FilePath));

        var fromEnd = Ok(await manager.GetLinkedEditingRangesAsync(Board, (10, 7), default));
        Assert.Equal(
            panel.Locations.Select(range => (range.Line, range.Character)),
            fromEnd.Locations.Select(range => (range.Line, range.Character))
        );

        Assert.Empty(
            Ok(await manager.GetLinkedEditingRangesAsync(Board, (8, 10), default)).Locations
        );
        Assert.Empty(
            Ok(await manager.GetLinkedEditingRangesAsync(Board, (6, 10), default)).Locations
        );
    }
}
