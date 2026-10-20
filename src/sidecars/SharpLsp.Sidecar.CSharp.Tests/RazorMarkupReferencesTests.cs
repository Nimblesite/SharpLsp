using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// References and highlights of components, against the real fixture solution: a component
/// type's references include every start and end tag that instantiates it, in every Razor
/// file, from markup or from C#; highlights keep the same rule to the file. Implements
/// [RAZOR-TESTING] for [RAZOR-FEATURES-REFERENCES].
/// </summary>
public sealed class RazorMarkupReferencesTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupReferencesTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Component_references_include_every_tag_that_instantiates_it()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var start = RazorFixture.Locate(Board, "<Tally TItem", "Tally");
        var end = RazorFixture.Locate(Board, "</Tally>", "Tally");
        var field = RazorFixture.Locate(Board, "private Tally<int>?", "Tally");
        (int, int)[] expected = [start, end, field];

        // From the end tag: both tag names and the C# use of the type.
        var fromTag = RazorFixture.Ok(
            await manager.GetReferencesAsync(Board, end.Line, end.Character + 1, false)
        );
        Assert.Equal(expected.Order(), InFile(fromTag.Locations, Board));
        Assert.All(fromTag.Locations, location => Assert.Equal("Tally", TextAt(location)));
        Assert.DoesNotContain(
            fromTag.Locations,
            location => NativePaths.HasExtension(location.FilePath, ".g.cs")
        );

        // From C#, the field's type: the tags are references too.
        var fromCode = RazorFixture.Ok(
            await manager.GetReferencesAsync(Board, field.Line, field.Character, false)
        );
        Assert.Equal(expected.Order(), InFile(fromCode.Locations, Board));
    }

    [Fact]
    public async Task A_class_library_component_finds_its_tags_in_the_apps_razor_files()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var start = RazorFixture.Locate(Board, "<Panel Title", "Panel");
        var end = RazorFixture.Locate(Board, "</Panel>", "Panel");

        var references = RazorFixture.Ok(
            await manager.GetReferencesAsync(Board, start.Line, start.Character + 1, true)
        );

        Assert.Equal(new[] { start, end }.Order(), InFile(references.Locations, Board));
        var declared = Assert.Single(
            references.Locations,
            location =>
                NativePaths.AreEqual(_fixture.Path("Widgets", "Panel.razor"), location.FilePath)
        );
        Assert.Equal((0, 0), (declared.Line, declared.Character));
    }

    [Fact]
    public async Task Highlights_on_a_component_tag_light_both_tag_names_and_its_csharp_uses()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var start = RazorFixture.Locate(Board, "<Tally TItem", "Tally");
        var end = RazorFixture.Locate(Board, "</Tally>", "Tally");
        var field = RazorFixture.Locate(Board, "private Tally<int>?", "Tally");

        var highlights = RazorFixture.Ok(
            await manager.GetDocumentHighlightsAsync(Board, start.Line, start.Character + 2)
        );

        Assert.Equal(
            new[] { start, end, field }.Order(),
            highlights.Highlights.Select(h => (h.StartLine, h.StartCharacter)).Order()
        );
        Assert.All(
            highlights.Highlights,
            h => Assert.Equal("Tally".Length, h.EndCharacter - h.StartCharacter)
        );
    }

    [Fact]
    public async Task Parameter_references_include_every_bind_x_that_names_it()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var tally = _fixture.Path("BlazorApp", "Components", "Shared", "Tally.razor");
        var declared = RazorFixture.Locate(tally, "public string Label", "Label");

        var references = RazorFixture.Ok(
            await manager.GetReferencesAsync(tally, declared.Line, declared.Character, false)
        );

        (int, int)[] bound = [RazorFixture.Locate(Board, "@bind-Label=", "Label")];
        Assert.Equal(bound, InFile(references.Locations, Board));
        Assert.Contains(
            RazorFixture.Locate(tally, "@Label</span>", "Label"),
            InFile(references.Locations, tally)
        );
    }

    private static IEnumerable<(int, int)> InFile(
        IEnumerable<LocationResult> locations,
        string file
    )
    {
        return locations
            .Where(location => NativePaths.AreEqual(file, location.FilePath))
            .Select(location => (location.Line, location.Character))
            .Order();
    }

    private static string TextAt(LocationResult location)
    {
        var line = File.ReadAllLines(location.FilePath)[location.Line];
        return line[location.Character..location.EndCharacter];
    }
}
