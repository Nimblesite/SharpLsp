using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The tags that instantiate a component type: every start and end tag name, in one Razor
/// file, whose component the compiler bound to that type. Implements
/// [RAZOR-FEATURES-REFERENCES].
/// </summary>
internal static class RazorComponentTags
{
    /// <summary>
    /// A type's identity across compilations: a component from a class library is a different
    /// symbol in each project that references it, but one documentation id.
    /// </summary>
    public static string? IdOf(ISymbol? symbol)
    {
        return (symbol as INamedTypeSymbol)?.OriginalDefinition.GetDocumentationCommentId();
    }

    /// <summary>The start and end tag names in <paramref name="markup"/> that instantiate the type <paramref name="typeId"/>.</summary>
    public static IEnumerable<TextSpan> Instantiating(
        RazorMarkup markup,
        Compilation compilation,
        string typeId
    )
    {
        return markup
            .Tags.Where(tag =>
                tag.Component is not null
                && IdOf(RazorMarkupSymbols.TypeOf(compilation, tag)) == typeId
            )
            .SelectMany(tag => tag.Names);
    }
}
