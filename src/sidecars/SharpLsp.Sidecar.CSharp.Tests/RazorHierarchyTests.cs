using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Call and type hierarchy from Razor positions, against the real fixture solution: each runs on
/// the file's C# projection and places its items and call sites in the Razor text, a component
/// class at the start of the file it is. Implements [RAZOR-TESTING] for [RAZOR-FEATURES-HIERARCHY]
/// and [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
public sealed class RazorHierarchyTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorHierarchyTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Ticker => _fixture.Path("BlazorApp", "Components", "Shared", "Ticker.razor");

    private string Counting => _fixture.Path("BlazorApp", "Components", "Shared", "Counting.cs");

    private string Edit => _fixture.Path("PagesApp", "Pages", "Edit.cshtml");

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    private string Panel => _fixture.Path("Widgets", "Panel.razor");

    private string Tally => _fixture.Path("BlazorApp", "Components", "Shared", "Tally.razor");

    [Fact]
    public async Task Call_hierarchy_answers_razor_items_and_razor_callers()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var at = RazorFixture.Locate(Ticker, "private void Hit", "Hit");

        // Prepare answers the method where the Razor file declares it.
        var prepared = RazorFixture.Ok(
            await manager.PrepareCallHierarchyAsync(Ticker, at.Line, at.Character)
        );
        Assert.NotNull(prepared);
        Assert.Equal(("Hit", "Method"), (prepared.Name, prepared.Kind));
        Assert.True(NativePaths.AreEqual(Ticker, prepared.FilePath), prepared.FilePath);
        Assert.Equal(at, (prepared.Line, prepared.Character));

        // Its markup click names a caller, which is the component the file renders.
        var calls = Assert.Single(
            RazorFixture.Ok(await manager.GetIncomingCallsAsync(Ticker, at.Line, at.Character))
        );
        Assert.Equal(("Ticker.razor", "Class"), (calls.Name, calls.Kind));
        Assert.True(NativePaths.AreEqual(Ticker, calls.FilePath), calls.FilePath);
        Assert.Equal((0, 0), (calls.Line, calls.Character));
        var clicked = Assert.Single(calls.FromRanges);
        Assert.Equal(
            RazorFixture.Locate(Ticker, "@onclick=\"Hit\"", "Hit", 3),
            (clicked.Line, clicked.EndCharacter)
        );
        Assert.Equal(clicked.Line, clicked.EndLine);

        // The call the @code block makes reaches the C# method it names, outside every projection.
        var outgoing = Assert.Single(
            RazorFixture.Ok(await manager.GetOutgoingCallsAsync(Ticker, at.Line, at.Character))
        );
        Assert.Equal("Bump", outgoing.Name);
        Assert.True(NativePaths.AreEqual(Counting, outgoing.FilePath), outgoing.FilePath);
        Assert.Equal(
            RazorFixture.Locate(Counting, "internal static int Bump", "Bump"),
            (outgoing.Line, outgoing.Character)
        );
        var called = Assert.Single(outgoing.FromRanges);
        Assert.Equal(
            RazorFixture.Locate(Ticker, "Counting.Bump(count)", "Counting.Bump(count)"),
            (called.Line, called.Character)
        );
        Assert.Equal(called.Character + "Counting.Bump(count)".Length, called.EndCharacter);
    }

    [Fact]
    public async Task Calls_from_razor_markup_list_the_razor_file_as_their_caller()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // A .cs method Razor code calls answers the Razor member that calls it, in its own file.
        var bump = RazorFixture.Locate(Counting, "internal static int Bump", "Bump");
        var callers = Assert.Single(
            RazorFixture.Ok(
                await manager.GetIncomingCallsAsync(Counting, bump.Line, bump.Character)
            )
        );
        var hit = RazorFixture.Locate(Ticker, "private void Hit", "Hit");
        Assert.Equal(("Hit", "Method"), (callers.Name, callers.Kind));
        Assert.True(NativePaths.AreEqual(Ticker, callers.FilePath), callers.FilePath);
        Assert.Equal(hit, (callers.Line, callers.Character));
        var site = Assert.Single(callers.FromRanges);
        Assert.Equal(
            RazorFixture.Locate(Ticker, "Counting.Bump(count)", "Bump"),
            (site.Line, site.Character)
        );
        Assert.Equal(site.Character + "Bump".Length, site.EndCharacter);

        // A call written in markup answers the page the markup is, at the call's own range.
        var shout = RazorFixture.Locate(Edit, "string Shout(string text)", "Shout");
        var prepared = RazorFixture.Ok(
            await manager.PrepareCallHierarchyAsync(Edit, shout.Line, shout.Character)
        );
        Assert.NotNull(prepared);
        Assert.Equal("Shout", prepared.Name);
        Assert.True(NativePaths.AreEqual(Edit, prepared.FilePath), prepared.FilePath);
        Assert.Equal(shout, (prepared.Line, prepared.Character));

        var markup = Assert.Single(
            RazorFixture.Ok(await manager.GetIncomingCallsAsync(Edit, shout.Line, shout.Character))
        );
        Assert.Equal(("Edit.cshtml", "Class"), (markup.Name, markup.Kind));
        Assert.True(NativePaths.AreEqual(Edit, markup.FilePath), markup.FilePath);
        Assert.Equal((0, 0), (markup.Line, markup.Character));
        var write = Assert.Single(markup.FromRanges);
        Assert.Equal(
            RazorFixture.Locate(Edit, "@Shout(Model.Title)", "Shout", "Shout".Length),
            (write.Line, write.EndCharacter)
        );

        // No answer names a generated file.
        Assert.False(NativePaths.HasExtension(markup.FilePath, ".g.cs"), markup.FilePath);
        Assert.False(NativePaths.HasExtension(prepared.FilePath, ".g.cs"), prepared.FilePath);
    }

    [Fact]
    public async Task Type_hierarchy_lands_component_classes_in_their_razor_files()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // A component's @inherits names the base component, which is its own file.
        var inherited = RazorFixture.Locate(Ticker, "@inherits Panel", "Panel");
        var panel = RazorFixture.Ok(
            await manager.PrepareTypeHierarchyAsync(Ticker, inherited.Line, inherited.Character)
        );
        Assert.NotNull(panel);
        Assert.Equal(("Panel", "Class"), (panel.Name, panel.Kind));
        Assert.True(NativePaths.AreEqual(Panel, panel.FilePath), panel.FilePath);
        Assert.Equal((0, 0), (panel.Line, panel.Character));

        // The follow-up a client makes from that item answers its subtypes, each in its own file.
        var subtypes = Assert.Single(RazorFixture.Ok(await manager.GetSubtypesAsync(Panel, 0, 0)));
        Assert.Equal(("Ticker", "Class"), (subtypes.Name, subtypes.Kind));
        Assert.True(NativePaths.AreEqual(Ticker, subtypes.FilePath), subtypes.FilePath);
        Assert.Equal((0, 0), (subtypes.Line, subtypes.Character));

        // Its supertype is a framework component, which has no source row to show.
        Assert.Empty(RazorFixture.Ok(await manager.GetSupertypesAsync(Panel, 0, 0)));

        // A component's type named in @code lands in the component's file too.
        var tally = RazorFixture.Locate(Board, "private Tally<int>?", "Tally");
        var prepared = RazorFixture.Ok(
            await manager.PrepareTypeHierarchyAsync(Board, tally.Line, tally.Character)
        );
        Assert.NotNull(prepared);
        Assert.Equal("Tally", prepared.Name);
        Assert.True(NativePaths.AreEqual(Tally, prepared.FilePath), prepared.FilePath);
        Assert.Equal((0, 0), (prepared.Line, prepared.Character));

        // A type authored in C# stays in its own file, not in the Razor file that names it.
        var model = RazorFixture.Locate(Edit, "@model EditModel", "EditModel");
        var declared = RazorFixture.Ok(
            await manager.PrepareTypeHierarchyAsync(Edit, model.Line, model.Character)
        );
        Assert.NotNull(declared);
        Assert.Equal("EditModel", declared.Name);
        Assert.True(
            NativePaths.AreEqual(
                _fixture.Path("PagesApp", "Pages", "Edit.cshtml.cs"),
                declared.FilePath
            ),
            declared.FilePath
        );
        Assert.Equal(
            RazorFixture.Locate(
                _fixture.Path("PagesApp", "Pages", "Edit.cshtml.cs"),
                "public class EditModel",
                "EditModel"
            ),
            (declared.Line, declared.Character)
        );
    }
}
