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
}
