using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Inlay hints of a projection read in the Razor file it belongs to: hints computed on the C#
/// the Razor lines map to, each placed at its Razor position. A hint outside every C# fragment
/// cannot be shown in the file, so it is dropped. Implements [RAZOR-ARCHITECTURE-PROJECTION]
/// and [RAZOR-FEATURES-INLAY-HINTS].
/// </summary>
internal static class RazorHints
{
    /// <summary>
    /// The generated lines the Razor <paramref name="startLine"/>..<paramref name="endLine"/>
    /// map to, the last one included so that a caller reading to the end of it sees its content;
    /// null when they cover no fragment, where the file has no C# to hint.
    /// </summary>
    public static (int Start, int End)? Lines(
        RazorProjection projection,
        int startLine,
        int endLine
    )
    {
        var lines = projection.RazorText.Lines;
        var window = TextSpan.FromBounds(
            lines[Clamped(lines, startLine)].Start,
            lines[Clamped(lines, endLine)].End
        );
        var covering = projection
            .Map.Mappings.Where(entry =>
                entry.RazorStart < window.End && window.Start < entry.RazorEnd
            )
            .ToList();
        return covering.Count == 0
            ? null
            : (
                LineOf(projection, covering.Min(entry => entry.GeneratedStart)),
                LineOf(projection, covering.Max(entry => entry.GeneratedEnd))
            );
    }

    /// <summary>
    /// <paramref name="hints"/>, whose positions are in the projection, placed in
    /// <paramref name="projection"/>'s Razor file when they lie within its lines
    /// <paramref name="startLine"/>..<paramref name="endLine"/>; the rest are dropped.
    /// </summary>
    public static List<InlayHintResult> Map(
        List<InlayHintResult> hints,
        RazorProjection projection,
        int startLine,
        int endLine
    )
    {
        return
        [
            .. hints
                .Select(hint => Map(hint, projection, startLine, endLine))
                .OfType<InlayHintResult>(),
        ];
    }

    private static InlayHintResult? Map(
        InlayHintResult hint,
        RazorProjection projection,
        int startLine,
        int endLine
    )
    {
        var at = new LinePosition(hint.Line, hint.Character);
        return
            projection.ToRazor(new LinePositionSpan(at, at)) is { } razor
            && razor.Start.Line >= startLine
            && razor.Start.Line <= endLine
            ? new InlayHintResult
            {
                Line = razor.Start.Line,
                Character = razor.Start.Character,
                Label = hint.Label,
                Kind = hint.Kind,
            }
            : null;
    }

    /// <summary>The generated line <paramref name="generatedOffset"/> is on.</summary>
    private static int LineOf(RazorProjection projection, int generatedOffset)
    {
        return projection.GeneratedText.Lines.GetLinePosition(generatedOffset).Line;
    }

    private static int Clamped(TextLineCollection lines, int line)
    {
        return Math.Clamp(line, 0, lines.Count - 1);
    }
}
