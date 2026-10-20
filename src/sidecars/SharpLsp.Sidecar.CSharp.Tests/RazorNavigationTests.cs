using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Navigation from Razor positions, against the real fixture solution: type definition,
/// declaration and implementation answer where a position maps into C#, and land in Razor
/// files, a component class authored in Razor in its <c>.razor</c> file. Implements
/// [RAZOR-TESTING] for [RAZOR-FEATURES-DEFINITION].
/// </summary>
public sealed class RazorNavigationTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorNavigationTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Tally => _fixture.Path("BlazorApp", "Components", "Shared", "Tally.razor");

    [Fact]
    public async Task Type_definition_from_a_razor_fragment_lands_in_the_component_razor_file()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // `tally` in `@ref="tally"` is a Tally<int>, a generic component authored in Razor.
        var reference = RazorFixture.Locate(Board, "@ref=\"tally\"", "tally\"");
        var type = RazorFixture.Ok(
            await manager.GetTypeDefinitionAsync(Board, reference.Line, reference.Character)
        );
        Assert.NotNull(type);
        Assert.True(NativePaths.AreEqual(Tally, type.FilePath), type.FilePath);
        Assert.Equal((0, 0), (type.Line, type.Character));

        // The field's declaration in the @code block answers the same.
        var field = RazorFixture.Locate(Board, "private Tally<int>? tally", "tally;");
        var declared = RazorFixture.Ok(
            await manager.GetTypeDefinitionAsync(Board, field.Line, field.Character)
        );
        Assert.NotNull(declared);
        Assert.True(NativePaths.AreEqual(Tally, declared.FilePath), declared.FilePath);

        // HTML is not C#: no type definition there.
        var html = RazorFixture.Locate(Board, "<button @onclick", "button");
        Assert.Null(
            RazorFixture.Ok(await manager.GetTypeDefinitionAsync(Board, html.Line, html.Character))
        );
    }

    [Fact]
    public async Task Declaration_and_implementation_answer_from_razor_positions()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // Board implements IDisposable (@implements): Dispose declares the interface member.
        var dispose = RazorFixture.Locate(Board, "public void Dispose()", "Dispose");
        var declaration = RazorFixture.Ok(
            await manager.GetDeclarationAsync(Board, dispose.Line, dispose.Character)
        );
        Assert.NotNull(declaration);
        Assert.False(NativePaths.IsRazor(declaration.FilePath), declaration.FilePath);
        Assert.Equal("Dispose", TextAt(declaration));

        // The interface the directive names has Board among its implementations, in Board.razor.
        var named = RazorFixture.Locate(Board, "@implements IDisposable", "IDisposable");
        var implementations = RazorFixture.Ok(
            await manager.GetImplementationsAsync(Board, named.Line, named.Character)
        );
        var board = Assert.Single(
            implementations.Locations,
            location => NativePaths.AreEqual(Board, location.FilePath)
        );
        Assert.Equal((0, 0), (board.Line, board.Character));
        Assert.DoesNotContain(
            implementations.Locations,
            location => NativePaths.HasExtension(location.FilePath, ".g.cs")
        );
    }

    private static string TextAt(LocationResult location)
    {
        var line = File.ReadAllLines(location.FilePath)[location.Line];
        return line[location.Character..location.EndCharacter];
    }
}
