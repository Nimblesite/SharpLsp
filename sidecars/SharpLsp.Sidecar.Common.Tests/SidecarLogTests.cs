using SharpLsp.Sidecar.Common.Logging;

namespace SharpLsp.Sidecar.Common.Tests;

// Regression guard for issue #78: a Roslyn type-load failure is surfaced by
// MSBuild as a diagnostic carrying dozens of identical "Could not load file or
// assembly" lines. The flood must collapse to a single annotated line.
public sealed class SidecarLogTests
{
    [Fact]
    public void CollapseRepeatedLines_collapses_a_type_load_flood_to_one_line()
    {
        const string loader =
            "Could not load file or assembly 'Microsoft.CodeAnalysis, Version=5.6.0.0'.";
        var flood =
            "Unable to load one or more of the requested types.\n"
            + string.Join('\n', Enumerable.Repeat(loader, 70));

        var collapsed = SidecarLog.CollapseRepeatedLines(flood);

        var lines = collapsed.Split('\n');
        Assert.Equal(2, lines.Length);
        Assert.Equal("Unable to load one or more of the requested types.", lines[0]);
        Assert.Contains(loader, lines[1], StringComparison.Ordinal);
        Assert.Contains("(repeated 70 times)", lines[1], StringComparison.Ordinal);
    }

    [Fact]
    public void CollapseRepeatedLines_preserves_distinct_lines_in_order()
    {
        Assert.Equal("alpha\nbeta\ngamma", SidecarLog.CollapseRepeatedLines("alpha\nbeta\ngamma"));
    }

    [Fact]
    public void CollapseRepeatedLines_normalizes_carriage_returns_before_collapsing()
    {
        Assert.Equal(
            "same (repeated 2 times)\nunique",
            SidecarLog.CollapseRepeatedLines("same\r\nsame\r\nunique")
        );
    }

    [Fact]
    public void CollapseRepeatedLines_leaves_a_single_line_untouched()
    {
        Assert.Equal("only one line", SidecarLog.CollapseRepeatedLines("only one line"));
    }
}
