using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A Razor file and its C# projection: the source-generated document whose
/// <c>#pragma checksum</c> names that file, with the verified map between the two.
/// Implements [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
internal sealed record RazorProjection(
    TextDocument Razor,
    SourceText RazorText,
    SourceGeneratedDocument Generated,
    SourceText GeneratedText,
    SyntaxNode GeneratedRoot,
    RazorSpanMap Map
)
{
    /// <summary>The Razor file's path, which its projection's checksum names, so never null.</summary>
    public string RazorPath => Razor.FilePath!;

    /// <summary>The component or view class the compiler generated for this file.</summary>
    public ClassDeclarationSyntax? FileClass =>
        GeneratedRoot.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault();

    /// <summary>The projection of <paramref name="razor"/>, or null when its project generates none.</summary>
    public static async Task<RazorProjection?> ForRazorAsync(
        TextDocument razor,
        CancellationToken ct
    )
    {
        var generatedDocuments = await razor
            .Project.GetSourceGeneratedDocumentsAsync(ct)
            .ConfigureAwait(false);
        foreach (var generated in generatedDocuments)
        {
            var root = await generated.GetSyntaxRootAsync(ct).ConfigureAwait(false);
            if (NativePaths.AreEqual(ChecksumPath(root), razor.FilePath))
            {
                return await CreateAsync(razor, generated, root!, ct).ConfigureAwait(false);
            }
        }

        return null;
    }

    /// <summary>The projection that <paramref name="generated"/> is, or null when it names no Razor file.</summary>
    public static async Task<RazorProjection?> ForGeneratedAsync(
        SourceGeneratedDocument generated,
        CancellationToken ct
    )
    {
        var root = await generated.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var path = ChecksumPath(root);
        var razor = generated.Project.AdditionalDocuments.FirstOrDefault(document =>
            NativePaths.IsRazor(path) && NativePaths.AreEqual(document.FilePath, path)
        );
        return razor is null
            ? null
            : await CreateAsync(razor, generated, root!, ct).ConfigureAwait(false);
    }

    /// <summary>The file a generated document's <c>#pragma checksum</c> names.</summary>
    internal static string? ChecksumPath(SyntaxNode? root)
    {
        return
            root is CSharpSyntaxNode node
            && node.GetFirstDirective(directive => directive is PragmaChecksumDirectiveTriviaSyntax)
                is PragmaChecksumDirectiveTriviaSyntax pragma
            ? pragma.File.ValueText
            : null;
    }

    /// <summary>
    /// This projection, of a copy of <paramref name="file"/>'s Razor file that
    /// <paramref name="insertions"/> made, read in the file itself. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    public RazorProjection ReadIn(RazorProjection file, ImmutableArray<TextChange> insertions)
    {
        return this with
        {
            Razor = file.Razor,
            RazorText = file.RazorText,
            Map = Map.Without(insertions),
        };
    }

    /// <summary>The generated position of a Razor position inside a C# fragment.</summary>
    public LinePosition? ToGenerated(LinePosition razorPosition)
    {
        return
            DocumentText.TryOffset(RazorText, razorPosition) is { } offset
            && Map.ToGenerated(offset) is { } generated
            ? GeneratedText.Lines.GetLinePosition(generated)
            : null;
    }

    /// <summary>The Razor range of a generated range that lies inside one fragment.</summary>
    public LinePositionSpan? ToRazor(LinePositionSpan generatedSpan)
    {
        return
            DocumentText.TrySpan(GeneratedText, generatedSpan) is { } span
            && Map.ToRazor(span) is { } razor
            ? RazorText.Lines.GetLinePositionSpan(razor)
            : null;
    }

    private static async Task<RazorProjection> CreateAsync(
        TextDocument razor,
        SourceGeneratedDocument generated,
        SyntaxNode root,
        CancellationToken ct
    )
    {
        var razorText = await razor.GetTextAsync(ct).ConfigureAwait(false);
        var generatedText = await generated.GetTextAsync(ct).ConfigureAwait(false);
        var map = RazorSpanMap.Build(root.SyntaxTree, generatedText, razorText, razor.FilePath!);
        return new RazorProjection(razor, razorText, generated, generatedText, root, map);
    }
}
