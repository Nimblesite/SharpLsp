using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Definition from Blazor markup, against the real fixture solution: a component tag goes
/// to its <c>.razor</c> file and any code-behind partial class, a component from metadata
/// to its decompiled source, and a component attribute or <c>@bind-X</c> to its parameter
/// property. Implements [RAZOR-TESTING] for [RAZOR-FEATURES-DEFINITION].
/// </summary>
public sealed class RazorMarkupDefinitionTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupDefinitionTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Shared(string file)
    {
        return _fixture.Path("BlazorApp", "Components", "Shared", file);
    }

    [Fact]
    public async Task Component_tags_go_to_their_razor_file_and_code_behind()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Badge is authored in Razor with a code-behind partial class: both are its definition.
        var badge = RazorFixture.Locate(Board, "<Badge Text=", "Badge");
        var both = RazorFixture.Ok(
            await manager.GetDefinitionAsync(Board, badge.Line, badge.Character + 1)
        );
        Assert.Equal(2, both.Locations.Count);
        var razor = Assert.Single(
            both.Locations,
            l => NativePaths.AreEqual(Shared("Badge.razor"), l.FilePath)
        );
        Assert.Equal((0, 0), (razor.Line, razor.Character));
        var codeBehind = Assert.Single(
            both.Locations,
            l => NativePaths.AreEqual(Shared("Badge.razor.cs"), l.FilePath)
        );
        Assert.Equal(
            RazorFixture.Locate(Shared("Badge.razor.cs"), "public partial class Badge", "Badge"),
            (codeBehind.Line, codeBehind.Character)
        );

        // The end tag goes to Tally.razor, a generic component without code-behind.
        var tally = RazorFixture.Locate(Board, "</Tally>", "Tally");
        var end = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Board, tally.Line, tally.Character))
                .Locations
        );
        Assert.True(NativePaths.AreEqual(Shared("Tally.razor"), end.FilePath), end.FilePath);

        // A framework component lands in its decompiled source, never a generated file.
        var title = RazorFixture.Locate(Board, "<PageTitle>", "PageTitle");
        var framework = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Board, title.Line, title.Character))
                .Locations
        );
        Assert.False(NativePaths.IsRazor(framework.FilePath), framework.FilePath);
        Assert.False(NativePaths.HasExtension(framework.FilePath, ".g.cs"), framework.FilePath);
        Assert.Equal("PageTitle", TextAt(framework));
    }

    [Fact]
    public async Task Bind_x_goes_to_the_parameter_it_binds()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // `@bind-` is markup; the parameter it binds is Tally's Label, declared in its @code block.
        var bind = RazorFixture.Locate(Board, "@bind-Label=", "@bind-Label");
        var declared = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Board, bind.Line, bind.Character + 2))
                .Locations
        );
        Assert.True(
            NativePaths.AreEqual(Shared("Tally.razor"), declared.FilePath),
            declared.FilePath
        );
        Assert.Equal(
            RazorFixture.Locate(Shared("Tally.razor"), "public string Label", "Label"),
            (declared.Line, declared.Character)
        );

        // HTML defines nothing.
        var button = RazorFixture.Locate(Board, "<button @onclick", "button");
        Assert.Empty(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Board, button.Line, button.Character))
                .Locations
        );
    }

    private static string TextAt(LocationResult location)
    {
        var line = File.ReadAllLines(location.FilePath)[location.Line];
        return line[location.Character..location.EndCharacter];
    }
}
