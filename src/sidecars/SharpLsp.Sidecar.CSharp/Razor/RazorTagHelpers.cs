using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Mvc.Razor.Extensions;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Razor;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The tag helpers a project can use, components included: discovered by the compiler's own
/// <see cref="CompilationTagHelperFeature"/> over the project's compilation (its generated
/// components among them) and every reference it compiles against, project references
/// included. They are compiler state held only as long as that compilation instance lives,
/// never a feature result. Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal static class RazorTagHelpers
{
    private static readonly ConditionalWeakTable<Compilation, TagHelperCollection> ByCompilation =
    [];

    /// <summary>The tag helpers of <paramref name="compilation"/>.</summary>
    public static TagHelperCollection Of(Compilation compilation)
    {
        return ByCompilation.GetValue(compilation, Discover);
    }

    private static TagHelperCollection Discover(Compilation compilation)
    {
        var references = new List<MetadataReference> { compilation.ToMetadataReference() };
        references.AddRange(compilation.References);
        var engine = RazorProjectEngine.Create(
            RazorConfiguration.Default,
            RazorProjectFileSystem.Empty,
            builder =>
            {
                builder.Features.Add(
                    new DefaultMetadataReferenceFeature { References = references }
                );
                builder.Features.Add(new CompilationTagHelperFeature());
                CompilerFeatures.Register(builder);
                RazorExtensions.Register(builder);
            }
        );
        return engine
            .Engine.GetFeatures<ITagHelperFeature>()[0]
            .GetTagHelpers(CancellationToken.None);
    }

    /// <summary>Hands an engine tag helpers already discovered for its compilation.</summary>
    internal sealed class Feature(TagHelperCollection tagHelpers)
        : RazorEngineFeatureBase,
            ITagHelperFeature
    {
        /// <inheritdoc />
        public TagHelperCollection GetTagHelpers(CancellationToken cancellationToken)
        {
            return tagHelpers;
        }
    }
}
