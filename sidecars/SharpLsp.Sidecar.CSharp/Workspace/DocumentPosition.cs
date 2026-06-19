using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Shared position-resolution helpers for symbol-at-cursor lookups. Collapses the
/// identical "fetch the semantic model and the syntax token at (line, character)"
/// preamble that the call-hierarchy and type-hierarchy resolvers each repeated.
/// </summary>
internal static class DocumentPosition
{
    /// <summary>
    /// Resolves the semantic model and the syntax token at the given
    /// (<paramref name="line"/>, <paramref name="character"/>) position in
    /// <paramref name="document"/>. Returns <see langword="null"/> when the document
    /// exposes no semantic model or syntax root.
    /// </summary>
    public static async Task<(SemanticModel Model, SyntaxToken Token)?> ResolveTokenAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return null;
        }

        var position = text.Lines.GetPosition(new LinePosition(line, character));
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return root is null ? null : (model, root.FindToken(position));
    }

    /// <summary>
    /// Projects a <see cref="FileLinePositionSpan"/> into the path plus start/end
    /// (line, character) coordinates shared by the call-hierarchy, type-hierarchy, and
    /// definition result shapes. Collapses the identical field-mapping block those
    /// resolvers each repeated.
    /// </summary>
    public static (string Path, int Line, int Character, int EndLine, int EndCharacter) Coordinates(
        FileLinePositionSpan span
    )
    {
        return (
            span.Path,
            span.StartLinePosition.Line,
            span.StartLinePosition.Character,
            span.EndLinePosition.Line,
            span.EndLinePosition.Character
        );
    }

    /// <summary>
    /// Builds a <see cref="LocationResult"/> from a <see cref="FileLinePositionSpan"/>
    /// using the shared <see cref="Coordinates"/> projection.
    /// </summary>
    public static LocationResult ToLocationResult(FileLinePositionSpan span)
    {
        var (path, line, character, endLine, endCharacter) = Coordinates(span);
        return new LocationResult
        {
            FilePath = path,
            Line = line,
            Character = character,
            EndLine = endLine,
            EndCharacter = endCharacter,
        };
    }
}
