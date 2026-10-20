using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Rename across C# and Razor, against the real fixture solution: a symbol renamed in a
/// <c>.cs</c> or <c>.razor</c> file takes every Razor usage with it, a <c>@bind-Old</c>
/// attribute becomes <c>@bind-New</c>, and a component tag is never renamed in place.
/// Implements [RAZOR-TESTING] for [RAZOR-FEATURES-RENAME].
/// </summary>
public sealed class RazorRenameTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorRenameTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Badge => _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor");

    private string Tally => _fixture.Path("BlazorApp", "Components", "Shared", "Tally.razor");

    [Fact]
    public async Task Prepare_rename_refuses_on_a_component_tag_start_or_end()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var start = RazorFixture.Locate(Board, "<Badge Text=", "Badge");
        var end = RazorFixture.Locate(Board, "</Tally>", "Tally");

        // A component is renamed by renaming its file, never through a tag.
        foreach (var (line, character) in new[] { start, end })
        {
            var prepared = RazorFixture.Ok(
                await manager.PrepareRenameAsync(Board, line, character)
            );
            Assert.False(prepared.CanRename, $"{line}:{character}");
        }
    }

    [Fact]
    public async Task Rename_from_a_code_behind_file_edits_every_razor_use_of_the_parameter()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var codeBehind = _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor.cs");
        var declared = RazorFixture.Locate(codeBehind, "public string Text", "Text");

        var edit = RazorFixture.Ok(
            await manager.RenameAsync(codeBehind, declared.Line, declared.Character, "Caption")
        );

        Assert.Equal(declared, Single(edit, codeBehind));
        Assert.Equal(RazorFixture.Locate(Badge, "@Text", "Text"), Single(edit, Badge));
        Assert.Equal(RazorFixture.Locate(Board, "<Badge Text=", "Text"), Single(edit, Board));
        Assert.All(
            edit.DocumentChanges.SelectMany(d => d.Edits),
            e => Assert.Equal("Caption", e.NewText)
        );
        Assert.DoesNotContain(
            edit.DocumentChanges,
            d => NativePaths.HasExtension(d.FilePath, ".g.cs")
        );
    }

    [Fact]
    public async Task Rename_of_a_bound_parameter_turns_bind_old_into_bind_new()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var declared = RazorFixture.Locate(Tally, "public string Label", "Label");

        var edit = RazorFixture.Ok(
            await manager.RenameAsync(Tally, declared.Line, declared.Character, "Title")
        );

        // `@bind-Label` names the parameter after `@bind-`: only `Label` changes.
        var bound = RazorFixture.Locate(Board, "@bind-Label=", "Label");
        Assert.Equal(bound, Single(edit, Board));
        var tally = Assert.Single(
            edit.DocumentChanges,
            d => NativePaths.AreEqual(Tally, d.FilePath)
        );
        Assert.Contains(
            (declared.Line, declared.Character),
            tally.Edits.Select(e => (e.StartLine, e.StartCharacter))
        );
        Assert.Contains(
            RazorFixture.Locate(Tally, "@Label</span>", "Label"),
            tally.Edits.Select(e => (e.StartLine, e.StartCharacter))
        );
        Assert.All(
            edit.DocumentChanges.SelectMany(d => d.Edits),
            e => Assert.Equal("Title", e.NewText)
        );
    }

    /// <summary>The one edit <paramref name="edit"/> makes in <paramref name="file"/>.</summary>
    private static (int Line, int Character) Single(WorkspaceEditResult edit, string file)
    {
        var document = Assert.Single(
            edit.DocumentChanges,
            d => NativePaths.AreEqual(file, d.FilePath)
        );
        var change = Assert.Single(document.Edits);
        return (change.StartLine, change.StartCharacter);
    }
}
