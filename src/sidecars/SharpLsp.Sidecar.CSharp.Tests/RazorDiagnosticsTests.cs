using Microsoft.AspNetCore.Razor.Language;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The Razor compiler's own (<c>RZ</c>) diagnostics, reported for the Razor file and in the
/// solution scan, against the real fixture solution. Implements [RAZOR-TESTING] for
/// [RAZOR-FEATURES-DIAGNOSTICS].
/// </summary>
public sealed class RazorDiagnosticsTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorDiagnosticsTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Razor_diagnostics_reach_the_file_and_the_solution_scan_with_lsp_severities()
    {
        using var manager = await _fixture.OpenManagerAsync();
        Assert.DoesNotContain(RazorFixture.Ok(await manager.GetDiagnosticsAsync(Board)), IsRazor);

        // An element no component binds is a warning; a component tag left open is an error.
        var text = await File.ReadAllTextAsync(Board);
        var broken =
            text.Replace("<Badge Text", "<Bdage Text", StringComparison.Ordinal)
            + "\n<Badge Text=\"open\">\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, broken));
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);
        Assert.Contains(markup.Diagnostics, d => d.Severity == RazorDiagnosticSeverity.Warning);
        Assert.Contains(markup.Diagnostics, d => d.Severity == RazorDiagnosticSeverity.Error);

        // Every one the compiler reports reaches the file, with its range and LSP severity.
        var reported = RazorFixture.Ok(await manager.GetDiagnosticsAsync(Board));
        var all = RazorFixture.Ok(await manager.GetAllDiagnosticsAsync([]));
        var scanned = Assert.Single(all, entry => NativePaths.AreEqual(entry.Key, Board)).Value;
        foreach (var expected in markup.Diagnostics.Select(d => Expected(markup, d)))
        {
            Assert.Contains(expected, reported.Where(IsRazor).Select(Shape));
            Assert.Contains(expected, scanned.Where(IsRazor).Select(Shape));
        }

        Assert.Equal(markup.Diagnostics.Length, reported.Count(IsRazor));
        var unknown = Assert.Single(reported, d => d.Code == "RZ10012");
        Assert.Equal("Warning", unknown.Severity);
        Assert.True(NativePaths.AreEqual(Board, unknown.FilePath), unknown.FilePath);
        Assert.Contains("Bdage", unknown.Message, StringComparison.Ordinal);
    }

    private static bool IsRazor(DiagnosticResult diagnostic)
    {
        return diagnostic.Code.StartsWith("RZ", StringComparison.Ordinal);
    }

    private static (string, string, int, int, int, int, string) Shape(DiagnosticResult d)
    {
        return (
            d.Code,
            d.Severity,
            d.StartLine,
            d.StartCharacter,
            d.EndLine,
            d.EndCharacter,
            d.Message
        );
    }

    private static (string, string, int, int, int, int, string) Expected(
        RazorMarkup markup,
        MarkupDiagnostic diagnostic
    )
    {
        var span = markup.Text.Lines.GetLinePositionSpan(diagnostic.Span);
        var severity = diagnostic.Severity == RazorDiagnosticSeverity.Error ? "Error" : "Warning";
        return (
            diagnostic.Id,
            severity,
            span.Start.Line,
            span.Start.Character,
            span.End.Line,
            span.End.Character,
            diagnostic.Message
        );
    }
}
