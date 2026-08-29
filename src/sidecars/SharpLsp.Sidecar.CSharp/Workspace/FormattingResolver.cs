using System.Diagnostics.CodeAnalysis;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Resolves document formatting via Roslyn's Formatter API.
/// Supports full-document, range, and on-type formatting.
///
/// SEQUESTERED: This code is not wired into the LSP server. SharpLsp does not provide
/// formatting — use CSharpier for C# and Fantomas via Ionide for F#.
/// See docs/formatting/README.md for details.
/// </summary>
[ExcludeFromCodeCoverage]
internal static class FormattingResolver
{
    /// <summary>Format an entire document, returning text edits.</summary>
    public static async Task<List<TextEditResult>> FormatDocumentAsync(
        Document document,
        CancellationToken ct
    )
    {
        var formatted = await Formatter
            .FormatAsync(document, cancellationToken: ct)
            .ConfigureAwait(false);
        return await DocumentText.ComputeEditsAsync(document, formatted, ct).ConfigureAwait(false);
    }

    /// <summary>Format a range within a document.</summary>
    public static async Task<List<TextEditResult>> FormatRangeAsync(
        Document document,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct
    )
    {
        var (_, span) = await DocumentText
            .ResolveSpanAsync(document, startLine, startCharacter, endLine, endCharacter, ct)
            .ConfigureAwait(false);

        return await FormatSpanAsync(document, span, ct).ConfigureAwait(false);
    }

    /// <summary>Format after typing a trigger character (semicolon, brace, newline).</summary>
    public static async Task<List<TextEditResult>> FormatOnTypeAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(line, character));

        // Format the line containing the trigger character.
        var lineInfo = text.Lines.GetLineFromPosition(position);
        return await FormatSpanAsync(document, lineInfo.Span, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Format <paramref name="span"/> within <paramref name="document"/> and project the
    /// result into granular text edits. Shared tail of the range and on-type formatters.
    /// </summary>
    private static async Task<List<TextEditResult>> FormatSpanAsync(
        Document document,
        TextSpan span,
        CancellationToken ct
    )
    {
        var formatted = await Formatter
            .FormatAsync(document, span, cancellationToken: ct)
            .ConfigureAwait(false);
        return await DocumentText.ComputeEditsAsync(document, formatted, ct).ConfigureAwait(false);
    }
}
