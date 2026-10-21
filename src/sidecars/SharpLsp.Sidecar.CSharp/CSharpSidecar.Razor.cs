using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

internal sealed partial class CSharpSidecar
{
    // Implements [RAZOR-ARCHITECTURE-ROUTING].
    private Task<ByteResult> HandleDocumentSymbolAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) => _workspace.GetDocumentSymbolsAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleFoldingRangeAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) => _workspace.GetFoldingRangesAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleLinkedEditingRangeAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(
            payload,
            (file, line, character, token) =>
                _workspace.GetLinkedEditingRangesAsync(file, (line, character), token),
            ct
        );
    }

    // Implements [RAZOR-FEATURES-SELECTION].
    private Task<ByteResult> HandleSelectionRangeAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (SelectionRangeRequest request) =>
                _workspace.GetSelectionRangesAsync(
                    request.FilePath,
                    [.. request.Positions.Select(position => (position.Line, position.Character))],
                    ct
                ),
            ct
        );
    }

    // Implements [RAZOR-ARCHITECTURE-HTML].
    private Task<ByteResult> HandleRazorHtmlProjectionAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (HtmlProjectionRequest request) =>
                _workspace.GetRazorHtmlProjectionAsync(
                    request.FilePath,
                    ct,
                    request.Position is [var line, var character] ? (line, character) : null
                ),
            ct
        );
    }
}

/// <summary>An optional caret restricts HTML forwarding to markup. [RAZOR-FEATURES-HTML]</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class HtmlProjectionRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public int[]? Position { get; init; }
}

/// <summary>The position-preserving HTML projection, [RAZOR-ARCHITECTURE-HTML].</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class HtmlProjectionResult
{
    [Key(0)]
    public string Text { get; set; } = "";
}

/// <summary>The Razor file and the carets whose selection ranges to chain. [RAZOR-FEATURES-SELECTION]</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class SelectionRangeRequest
{
    [Key(0)]
    public string FilePath { get; set; } = "";

    [Key(1)]
    public List<SelectionRangePosition> Positions { get; set; } = [];
}

/// <summary>One caret of a <see cref="SelectionRangeRequest"/>.</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class SelectionRangePosition
{
    [Key(0)]
    public int Line { get; init; }

    [Key(1)]
    public int Character { get; init; }
}

/// <summary>One position's selection ranges, innermost first. [RAZOR-FEATURES-SELECTION]</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class SelectionRangeResult
{
    [Key(0)]
    public List<SelectionSpanResult> Ranges { get; set; } = [];
}

/// <summary>A range of the Razor file.</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class SelectionSpanResult
{
    [Key(0)]
    public int StartLine { get; init; }

    [Key(1)]
    public int StartCharacter { get; init; }

    [Key(2)]
    public int EndLine { get; init; }

    [Key(3)]
    public int EndCharacter { get; init; }
}
