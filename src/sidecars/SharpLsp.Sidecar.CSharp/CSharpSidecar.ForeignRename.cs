using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

internal sealed partial class CSharpSidecar
{
    private async Task<ByteResult> HandleRenameIdentityAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetRenameIdentityAsync(request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleRenameForeignAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<RenameForeignRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .RenameForeignAsync(request.AssemblyName, request.XmlDocSig, request.NewName, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
