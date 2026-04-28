using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for call hierarchy and type hierarchy.
/// </summary>
internal sealed partial class CSharpSidecar
{
    private async Task<ByteResult> HandlePrepareCallHierarchyAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .PrepareCallHierarchyAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleIncomingCallsAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetIncomingCallsAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleOutgoingCallsAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetOutgoingCallsAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandlePrepareTypeHierarchyAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .PrepareTypeHierarchyAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleSupertypesAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetSupertypesAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleSubtypesAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var req = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetSubtypesAsync(req.FilePath, req.Line, req.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
