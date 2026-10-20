using Microsoft.CodeAnalysis.Classification;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Semantic tokens for a Razor file: Roslyn's classification of each C# fragment in the
/// projection, shifted to the fragment's place in the Razor file, and the markup names the
/// compiler binds. Implements [RAZOR-FEATURES-SEMANTIC-TOKENS].
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

    /// <summary>
    /// The typed spans of the markup names the compiler binds: component and child-content
    /// tags are classes, component and tag helper attributes properties, directive attributes
    /// and their parameters decorators, and directives keywords.
    /// </summary>
    public static IEnumerable<SemanticSpan> MarkupSpans(RazorMarkup markup)
    {
        var tags = markup
            .Tags.Where(tag => tag.Component is not null || tag.ChildContent is not null)
            .SelectMany(tag => tag.Names)
            .Select(name => new SemanticSpan(name, TokenType("class")));
        var attributes = markup
            .Attributes.Where(attribute => attribute.Kind != MarkupAttributeKind.Html)
            .Select(attribute => (attribute.NameSpan, Type: AttributeType(attribute.Kind)))
            .Where(named => named.NameSpan is not null)
            .Select(named => new SemanticSpan(named.NameSpan!.Value, named.Type));
        var directives = markup.Directives.Select(directive => new SemanticSpan(
            directive.NameSpan,
            TokenType("keyword")
        ));
        return tags.Concat(attributes).Concat(directives);
    }

    /// <summary>
    /// The markup spans beside the C# ones: a markup span that runs into a C# span keeps only
    /// its part before it, since no two tokens overlap.
    /// </summary>
    public static IEnumerable<SemanticSpan> Beside(
        IReadOnlyList<SemanticSpan> csharp,
        IEnumerable<SemanticSpan> markup
    )
    {
        foreach (var span in markup)
        {
            var cut = csharp
                .Where(code => code.Span.OverlapsWith(span.Span))
                .Select(code => code.Span.Start)
                .DefaultIfEmpty(span.Span.End)
                .Min();
            if (cut > span.Span.Start)
            {
                yield return span with
                {
                    Span = TextSpan.FromBounds(span.Span.Start, cut),
                };
            }
        }
    }

    private static int AttributeType(MarkupAttributeKind kind)
    {
        return TokenType(kind == MarkupAttributeKind.Property ? "property" : "decorator");
    }

    private static int TokenType(string name)
    {
        return Array.IndexOf(SemanticTokensResolver.GetTokenTypes(), name);
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
