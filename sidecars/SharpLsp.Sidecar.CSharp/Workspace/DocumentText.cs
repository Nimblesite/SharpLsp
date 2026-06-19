using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Shared text-and-range helpers for document operations. Collapses the identical
/// "fetch the source text and resolve a (line, character) range to a <see cref="TextSpan"/>"
/// preamble that the semantic-tokens and formatting range resolvers each repeated.
/// </summary>
internal static class DocumentText
{
    /// <summary>
    /// Fetches the source text of <paramref name="document"/> and resolves the
    /// (<paramref name="startLine"/>, <paramref name="startCharacter"/>) –
    /// (<paramref name="endLine"/>, <paramref name="endCharacter"/>) range to a
    /// <see cref="TextSpan"/>. Returns both the text and the span so callers that
    /// need the text for further work avoid a second fetch.
    /// </summary>
    public static async Task<(SourceText Text, TextSpan Span)> ResolveSpanAsync(
        Document document,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var start = text.Lines.GetPosition(new LinePosition(startLine, startCharacter));
        var end = text.Lines.GetPosition(new LinePosition(endLine, endCharacter));
        return (text, TextSpan.FromBounds(start, end));
    }

    /// <summary>
    /// Project a single <see cref="TextChange"/> into a <see cref="TextEditResult"/>,
    /// resolving its span to start/end (line, character) coordinates against
    /// <paramref name="text"/>. Collapses the identical change-to-edit mapping that the
    /// formatting, code-action, and completion-resolve flows each repeated.
    /// </summary>
    public static TextEditResult ToTextEdit(SourceText text, TextChange change)
    {
        var start = text.Lines.GetLinePosition(change.Span.Start);
        var end = text.Lines.GetLinePosition(change.Span.End);
        return new TextEditResult
        {
            StartLine = start.Line,
            StartCharacter = start.Character,
            EndLine = end.Line,
            EndCharacter = end.Character,
            NewText = change.NewText ?? "",
        };
    }

    /// <summary>
    /// Compute the granular <see cref="TextEditResult"/> list that turns
    /// <paramref name="oldDoc"/> into <paramref name="newDoc"/>. Collapses the identical
    /// "diff two documents and map each change" body shared by the formatting and
    /// code-action resolvers.
    /// </summary>
    public static async Task<List<TextEditResult>> ComputeEditsAsync(
        Document oldDoc,
        Document newDoc,
        CancellationToken ct
    )
    {
        var oldText = await oldDoc.GetTextAsync(ct).ConfigureAwait(false);
        var newText = await newDoc.GetTextAsync(ct).ConfigureAwait(false);
        return [.. newText.GetTextChanges(oldText).Select(change => ToTextEdit(oldText, change))];
    }
}
