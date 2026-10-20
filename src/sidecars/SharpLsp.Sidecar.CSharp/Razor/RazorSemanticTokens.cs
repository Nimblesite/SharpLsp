using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Semantic tokens for a Razor file's C# fragments: Roslyn's classification of each
/// fragment in the projection, shifted to the fragment's place in the Razor file.
/// Implements [RAZOR-FEATURES-SEMANTIC-TOKENS].
/// </summary>
internal static class RazorSemanticTokens
{
    /// <summary>The typed spans of every C# fragment of <paramref name="projection"/>, in Razor offsets.</summary>
    public static async Task<List<SemanticSpan>> CSharpSpansAsync(
        RazorProjection projection,
        CancellationToken ct
    )
    {
        var spans = new List<SemanticSpan>();
        foreach (var mapping in projection.Map.Mappings.Where(mapping => mapping.Length > 0))
        {
            var generated = new TextSpan(mapping.GeneratedStart, mapping.Length);
            var classified = await Classifier
                .GetClassifiedSpansAsync(projection.Generated, generated, ct)
                .ConfigureAwait(false);
            spans.AddRange(classified.Select(span => Shift(span, mapping)).OfType<SemanticSpan>());
        }

        return spans;
    }

    /// <summary>A classified generated span moved into the Razor file, when it lies inside its fragment.</summary>
    private static SemanticSpan? Shift(ClassifiedSpan span, RazorMapping mapping)
    {
        var start = Math.Max(span.TextSpan.Start, mapping.GeneratedStart);
        var end = Math.Min(span.TextSpan.End, mapping.GeneratedEnd);
        return end > start
            ? new SemanticSpan(
                new TextSpan(mapping.RazorStart + (start - mapping.GeneratedStart), end - start),
                SemanticTokensResolver.MapClassification(span.ClassificationType)
            )
            : null;
    }
}
