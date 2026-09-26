using SharpLsp.Sidecar.Common.Messages;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>The active target framework requests. Implements [NETFX-CONTEXT].</summary>
internal sealed partial class CSharpSidecar
{
    private Task<ByteResult> HandleTargetFrameworkAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (TargetFrameworkRequest request) =>
                _workspace.GetTargetFrameworksAsync(request.FilePath, ct),
            ct
        );
    }

    private Task<ByteResult> HandleSetTargetFrameworkAsync(byte[] payload, CancellationToken ct)
    {
        return HandleRequestAsync(
            payload,
            (TargetFrameworkRequest request) =>
                _workspace.SetTargetFrameworkAsync(
                    request.FilePath,
                    request.TargetFramework ?? "",
                    ct
                ),
            ct
        );
    }
}
