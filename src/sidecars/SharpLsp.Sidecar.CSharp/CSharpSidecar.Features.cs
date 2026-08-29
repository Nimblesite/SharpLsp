using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for code lens, formatting, semantic tokens, and inlay hints.
/// </summary>
internal sealed partial class CSharpSidecar
{
    private async Task<ByteResult> HandleCodeLensAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetCodeLensesAsync(request.FilePath, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleFormattingAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .FormatDocumentAsync(request.FilePath, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleRangeFormattingAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<RangeFormattingRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .FormatRangeAsync(
                    request.FilePath,
                    request.StartLine,
                    request.StartCharacter,
                    request.EndLine,
                    request.EndCharacter,
                    ct
                )
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleOnTypeFormattingAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<OnTypeFormattingRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .FormatOnTypeAsync(request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleSemanticTokensFullAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetSemanticTokensFullAsync(request.FilePath, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleSemanticTokensRangeAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<RangeFormattingRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetSemanticTokensRangeAsync(
                    request.FilePath,
                    request.StartLine,
                    request.StartCharacter,
                    request.EndLine,
                    request.EndCharacter,
                    ct
                )
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleInlayHintAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<InlayHintRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetInlayHintsAsync(request.FilePath, request.StartLine, request.EndLine, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    // Implements [RENAME-PREPARE]
    private async Task<ByteResult> HandlePrepareRenameAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .PrepareRenameAsync(request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    // Implements [RENAME-APPLY]
    private async Task<ByteResult> HandleRenameAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<RenameRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .RenameAsync(request.FilePath, request.Line, request.Character, request.NewName, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
