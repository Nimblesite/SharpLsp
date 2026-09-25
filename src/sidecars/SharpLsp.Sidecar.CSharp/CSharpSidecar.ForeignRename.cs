using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

internal sealed partial class CSharpSidecar
{
    private Task<ByteResult> HandleRenameIdentityAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetRenameIdentityAsync, ct);
    }

    private Task<ByteResult> HandleRenameForeignAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (RenameForeignRequest request) =>
                _workspace.RenameForeignAsync(
                    request.AssemblyName,
                    request.XmlDocSig,
                    request.NewName,
                    ct
                ),
            ct
        );
    }
}
