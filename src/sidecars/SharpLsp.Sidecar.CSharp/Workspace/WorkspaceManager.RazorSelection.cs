using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Selection ranges of Razor files: each position chains from its innermost C# fragment or
/// markup span out to the whole document, so an editor can grow the selection outward. A file
/// no project lists, or a non-Razor path, answers empty. Implements
/// [RAZOR-FEATURES-SELECTION].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>One answer per position, in order; empty when the file has no workspace presence.</summary>
    public async Task<Outcome.Result<List<SelectionRangeResult>, string>> GetSelectionRangesAsync(
        string filePath,
        List<(int Line, int Character)> positions,
        CancellationToken ct
    )
    {
        try
        {
            var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
            var markup = await FindRazorMarkupAsync(filePath, ct).ConfigureAwait(false);
            var text = markup?.Text ?? projection?.RazorText;
            return new Outcome.Result<List<SelectionRangeResult>, string>.Ok<
                List<SelectionRangeResult>,
                string
            >(
                text is null
                    ? [.. positions.Select(_ => new SelectionRangeResult())]
                    : [.. positions.Select(position => At(projection, markup, text, position))]
            );
        }
        catch (Exception ex)
        {
            return Outcome.Result<List<SelectionRangeResult>, string>.Failure(ex.Message);
        }
    }

    /// <summary>One position's chain, mapped onto the file's lines.</summary>
    private static SelectionRangeResult At(
        RazorProjection? projection,
        RazorMarkup? markup,
        SourceText text,
        (int Line, int Character) position
    )
    {
        var offset = DocumentText.TryOffset(
            text,
            new LinePosition(position.Line, position.Character)
        );
        return new SelectionRangeResult
        {
            Ranges =
            [
                .. (
                    offset is { } found ? RazorSelectionRanges.At(projection, markup, found) : []
                ).Select(span => SpanOf(text, span)),
            ],
        };
    }

    /// <summary>A Razor offset span as its (line, character) bounds.</summary>
    private static SelectionSpanResult SpanOf(SourceText text, TextSpan span)
    {
        var at = text.Lines.GetLinePositionSpan(span);
        return new SelectionSpanResult
        {
            StartLine = at.Start.Line,
            StartCharacter = at.Start.Character,
            EndLine = at.End.Line,
            EndCharacter = at.End.Character,
        };
    }
}
