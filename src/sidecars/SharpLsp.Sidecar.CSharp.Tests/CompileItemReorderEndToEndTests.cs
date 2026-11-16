// End-to-end tests for moving an MSBuild <Compile> item ([SE-REORDER-FILE-REQUEST]),
// the F# compile-order fix. Drives `project/reorderCompileItems` through the real
// sidecar socket onto MSBuild's ProjectRootElement and pins what the retired
// line splicer broke: multi-line items, conditions, comments, CRLF and the BOM.
using System.Text;
using static SharpLsp.Sidecar.CSharp.Tests.CompileItemKit;

// xunit test classes must be public, so CA1515 (types can be internal) cannot apply.
#pragma warning disable CA1515
// Assert.Contains(string, string) is an ordinal substring check.
#pragma warning disable CA1307
// RS1035 bans File/Directory for *analyzers*; this test reads project files on disk.
#pragma warning disable RS1035
// xunit Assert.* return values are intentionally unused.
#pragma warning disable IDE0058

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class CompileItemReorderEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private const string Reorder = "project/reorderCompileItems";

    private Task<PackageEditResult> MoveAsync(
        string filePath,
        string include,
        string anchor,
        string position = "before"
    )
    {
        return fixture.SendAndDeserializeAsync<PackageEditResult>(
            Reorder,
            CompileRequest(filePath, include, anchor, position)
        );
    }

    /// <summary>A misordered F# project whose items carry everything a splicer breaks.</summary>
    private static string RichFsproj()
    {
        return Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <ItemGroup>",
            "    <!-- Program uses Domain: Domain must come first -->",
            "    <Compile Include=\"Program.fs\" />",
            "    <!-- platform glue -->",
            "    <Compile Include=\"Platform.fs\" Condition=\"'$(OS)' == 'Windows_NT'\" />",
            "    <Compile Include=\"../Shared/Domain.fs\">",
            "      <Link>Domain.fs</Link>",
            "    </Compile>",
            "  </ItemGroup>",
            "</Project>"
        );
    }

    [Fact]
    public async Task Multi_line_linked_item_moves_whole_and_everything_else_is_kept()
    {
        var path = await CreateProjectAsync(fixture.TempDir, "Rich.fsproj", RichFsproj());

        var moved = await MoveAsync(path, "../Shared/Domain.fs", "Program.fs");

        Assert.True(moved.Modified);
        Assert.Contains("../Shared/Domain.fs", moved.Message);
        Assert.Equal(["../Shared/Domain.fs", "Program.fs", "Platform.fs"], CompileOrder(path));
        var bytes = await File.ReadAllBytesAsync(path);
        Assert.True(bytes is [0xEF, 0xBB, 0xBF, ..], "the BOM survives the move");
        var text = Encoding.UTF8.GetString(bytes);
        // The <Link> child travelled inside its item, exactly once.
        Assert.Single(text.Split("<Link>Domain.fs</Link>"), part => part.Contains("Program.fs"));
        Assert.True(
            text.IndexOf("<Link>Domain.fs</Link>", StringComparison.Ordinal)
                < text.IndexOf("Include=\"Program.fs\"", StringComparison.Ordinal),
            text
        );
        // Comments, the condition and CRLF are untouched.
        Assert.Contains("<!-- Program uses Domain: Domain must come first -->", text);
        Assert.Contains("<!-- platform glue -->", text);
        Assert.Contains("Condition=\"'$(OS)' == 'Windows_NT'\"", text);
        Assert.DoesNotContain("\n", text.Replace("\r\n", ""));

        // Second interaction: the same move again is a no-op, byte for byte.
        var again = await MoveAsync(path, "../Shared/Domain.fs", "Program.fs");
        Assert.False(again.Modified);
        Assert.Contains("already in place", again.Message);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task Conditional_item_moves_after_an_anchor_with_its_condition()
    {
        var path = await CreateProjectAsync(fixture.TempDir, "Cond.fsproj", RichFsproj());

        var moved = await MoveAsync(path, "Platform.fs", "..\\Shared\\Domain.fs", "after");

        Assert.True(moved.Modified);
        Assert.Equal(["Program.fs", "../Shared/Domain.fs", "Platform.fs"], CompileOrder(path));
        var text = await File.ReadAllTextAsync(path);
        Assert.Contains(
            "<Compile Include=\"Platform.fs\" Condition=\"'$(OS)' == 'Windows_NT'\" />",
            text
        );
        Assert.Contains("<!-- platform glue -->", text);
        Assert.Contains("<Link>Domain.fs</Link>", text);
        Assert.DoesNotContain("\n", text.Replace("\r\n", ""));

        // Moving it back before the first item restores a valid order too.
        var back = await MoveAsync(path, "Platform.fs", "Program.fs");
        Assert.True(back.Modified);
        Assert.Equal(["Platform.fs", "Program.fs", "../Shared/Domain.fs"], CompileOrder(path));
        Assert.Contains("Condition=\"'$(OS)' == 'Windows_NT'\"", await File.ReadAllTextAsync(path));
    }

    [Fact]
    public async Task Simple_move_produces_exactly_the_reordered_text()
    {
        var before = Crlf(
            "<Project Sdk=\"Microsoft.NET.Sdk\">",
            "  <ItemGroup>",
            "    <Compile Include=\"Program.fs\" />",
            "    <Compile Include=\"Library.fs\" />",
            "    <Compile Include=\"Domain.fs\" />",
            "  </ItemGroup>",
            "</Project>"
        );
        var path = await CreateProjectAsync(fixture.TempDir, "Simple.fsproj", before, bom: false);

        var moved = await MoveAsync(path, "Domain.fs", "Program.fs");

        Assert.True(moved.Modified);
        Assert.Equal(
            Crlf(
                "<Project Sdk=\"Microsoft.NET.Sdk\">",
                "  <ItemGroup>",
                "    <Compile Include=\"Domain.fs\" />",
                "    <Compile Include=\"Program.fs\" />",
                "    <Compile Include=\"Library.fs\" />",
                "  </ItemGroup>",
                "</Project>"
            ),
            await File.ReadAllTextAsync(path)
        );
        var bytes = await File.ReadAllBytesAsync(path);
        Assert.False(bytes is [0xEF, 0xBB, 0xBF, ..], "no BOM is invented");
    }

    [Fact]
    public async Task Unknown_item_or_anchor_is_an_error_and_touches_nothing()
    {
        var path = await CreateProjectAsync(fixture.TempDir, "Missing.fsproj", RichFsproj());
        var before = await File.ReadAllBytesAsync(path);

        var noItem = await fixture.SendAsync(
            Reorder,
            CompileRequest(path, "Nope.fs", "Program.fs")
        );
        Assert.NotNull(noItem.Error);
        Assert.Contains("Nope.fs", noItem.Error);
        Assert.Equal(before, await File.ReadAllBytesAsync(path));

        var noAnchor = await fixture.SendAsync(
            Reorder,
            CompileRequest(path, "Program.fs", "Gone.fs", "after")
        );
        Assert.NotNull(noAnchor.Error);
        Assert.Contains("Gone.fs", noAnchor.Error);
        Assert.Equal(before, await File.ReadAllBytesAsync(path));

        // An item anchored to itself has nowhere to go.
        var self = await MoveAsync(path, "Program.fs", "Program.fs");
        Assert.False(self.Modified);
        Assert.Equal(before, await File.ReadAllBytesAsync(path));
    }
}
