using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>One C# fragment: the same text at a Razor offset and at a generated offset.</summary>
internal readonly record struct RazorMapping(int RazorStart, int GeneratedStart, int Length)
{
    public int RazorEnd => RazorStart + Length;

    public int GeneratedEnd => GeneratedStart + Length;
}

/// <summary>
/// The verified map between a Razor file and its C# projection, built from the projection's
/// <c>#line</c> mappings. Every entry pairs two spans that hold the same text, measured by
/// comparing that text, because Roslyn reports a mapped span's end one character past the
/// fragment. Implements [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
internal sealed class RazorSpanMap(ImmutableArray<RazorMapping> mappings)
{
    public ImmutableArray<RazorMapping> Mappings => mappings;

    /// <summary>Build the map from the <paramref name="tree"/>'s mappings into <paramref name="razorPath"/>.</summary>
    public static RazorSpanMap Build(
        SyntaxTree tree,
        SourceText generated,
        SourceText razor,
        string razorPath
    )
    {
        return new([
            .. tree.GetLineMappings()
                .Where(mapping => Targets(mapping, razorPath))
                .Select(mapping => Measure(mapping, generated, razor))
                .OfType<RazorMapping>()
                .OrderBy(mapping => mapping.RazorStart),
        ]);
    }

    /// <summary>
    /// The generated offset of a Razor offset that some entry contains or ends at; the
    /// containing entry wins, so a caret just after <c>@curr</c> still maps.
    /// </summary>
    public int? ToGenerated(int razorOffset)
    {
        var containing = mappings.FirstOrDefault(entry =>
            entry.RazorStart <= razorOffset && razorOffset < entry.RazorEnd
        );
        var entry = containing.Length > 0 ? containing : EndingAt(razorOffset);
        return entry is { } found ? found.GeneratedStart + (razorOffset - found.RazorStart) : null;
    }

    /// <summary>The Razor span of a generated span that lies entirely inside one entry.</summary>
    public TextSpan? ToRazor(TextSpan generated)
    {
        foreach (var entry in mappings)
        {
            if (entry.GeneratedStart <= generated.Start && generated.End <= entry.GeneratedEnd)
            {
                return new TextSpan(
                    entry.RazorStart + (generated.Start - entry.GeneratedStart),
                    generated.Length
                );
            }
        }

        return null;
    }

    private RazorMapping? EndingAt(int razorOffset)
    {
        foreach (var entry in mappings)
        {
            if (entry.RazorEnd == razorOffset)
            {
                return entry;
            }
        }

        return null;
    }

    private static bool Targets(LineMapping mapping, string razorPath)
    {
        return !mapping.IsHidden
            && mapping.MappedSpan.HasMappedPath
            && NativePaths.AreEqual(mapping.MappedSpan.Path, razorPath);
    }

    private static RazorMapping? Measure(
        LineMapping mapping,
        SourceText generated,
        SourceText razor
    )
    {
        var razorSpan = mapping.MappedSpan.Span;
        if (!Fits(razor, razorSpan.Start) || !Fits(generated, mapping.Span.Start))
        {
            return null;
        }

        var razorStart = razor.Lines.GetPosition(razorSpan.Start);
        var generatedLine = generated.Lines[mapping.Span.Start.Line];
        var generatedStart = generatedLine.Start + (mapping.CharacterOffset ?? 0);
        var bound = Bound(razor, razorSpan.End) - razorStart;
        var length = CommonLength(razor, razorStart, generated, generatedStart, bound);
        return new RazorMapping(razorStart, generatedStart, length);
    }

    private static bool Fits(SourceText text, LinePosition position)
    {
        return position.Line < text.Lines.Count
            && position.Character <= text.Lines[position.Line].SpanIncludingLineBreak.Length;
    }

    private static int Bound(SourceText razor, LinePosition end)
    {
        return Fits(razor, end) ? razor.Lines.GetPosition(end) : razor.Length;
    }

    private static int CommonLength(
        SourceText razor,
        int razorStart,
        SourceText generated,
        int generatedStart,
        int bound
    )
    {
        // The bound never runs past the Razor text, so only the generated end needs a check.
        var length = 0;
        while (
            length < bound
            && generatedStart + length < generated.Length
            && razor[razorStart + length] == generated[generatedStart + length]
        )
        {
            length++;
        }

        return length;
    }
}
