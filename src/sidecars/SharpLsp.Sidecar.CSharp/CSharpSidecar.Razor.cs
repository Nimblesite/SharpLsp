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

    // Implements [RAZOR-ARCHITECTURE-HTML].
    private Task<ByteResult> HandleRazorHtmlProjectionAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) =>
                _workspace.GetRazorHtmlProjectionAsync(request.FilePath, ct),
            ct
        );
    }
}

/// <summary>The position-preserving HTML projection, [RAZOR-ARCHITECTURE-HTML].</summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class HtmlProjectionResult
{
    [Key(0)]
    public string Text { get; set; } = "";
}
