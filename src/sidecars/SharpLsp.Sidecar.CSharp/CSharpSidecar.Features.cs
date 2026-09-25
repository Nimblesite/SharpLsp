using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for code lens, formatting, semantic tokens, and inlay hints.
/// </summary>
internal sealed partial class CSharpSidecar
{
    private Task<ByteResult> HandleCodeLensAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) => _workspace.GetCodeLensesAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleFormattingAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) => _workspace.FormatDocumentAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleRangeFormattingAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (RangeFormattingRequest request) =>
                _workspace.FormatRangeAsync(
                    request.FilePath,
                    request.StartLine,
                    request.StartCharacter,
                    request.EndLine,
                    request.EndCharacter,
                    ct
                ),
            ct
        );
    }

    private Task<ByteResult> HandleOnTypeFormattingAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (OnTypeFormattingRequest request) =>
                _workspace.FormatOnTypeAsync(request.FilePath, request.Line, request.Character, ct),
            ct
        );
    }

    private Task<ByteResult> HandleSemanticTokensFullAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (PositionRequest request) =>
                _workspace.GetSemanticTokensFullAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleSemanticTokensRangeAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (RangeFormattingRequest request) =>
                _workspace.GetSemanticTokensRangeAsync(
                    request.FilePath,
                    request.StartLine,
                    request.StartCharacter,
                    request.EndLine,
                    request.EndCharacter,
                    ct
                ),
            ct
        );
    }

    private Task<ByteResult> HandleInlayHintAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (InlayHintRequest request) =>
                _workspace.GetInlayHintsAsync(
                    request.FilePath,
                    request.StartLine,
                    request.EndLine,
                    ct
                ),
            ct
        );
    }

    // Implements [RENAME-PREPARE]
    private Task<ByteResult> HandlePrepareRenameAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.PrepareRenameAsync, ct);
    }

    // Implements [RENAME-APPLY]
    private Task<ByteResult> HandleRenameAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (RenameRequest request) =>
                _workspace.RenameAsync(
                    request.FilePath,
                    request.Line,
                    request.Character,
                    request.NewName,
                    ct
                ),
            ct
        );
    }
}
