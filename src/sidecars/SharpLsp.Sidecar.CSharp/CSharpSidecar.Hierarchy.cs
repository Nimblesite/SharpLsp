using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for call hierarchy and type hierarchy. Every one of them takes a
/// cursor position and answers with the workspace's result, so each is the
/// shared position-request skeleton pointed at a different workspace method.
/// </summary>
internal sealed partial class CSharpSidecar
{
    private Task<ByteResult> HandlePrepareCallHierarchyAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.PrepareCallHierarchyAsync, ct);
    }

    private Task<ByteResult> HandleIncomingCallsAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetIncomingCallsAsync, ct);
    }

    private Task<ByteResult> HandleOutgoingCallsAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetOutgoingCallsAsync, ct);
    }

    private Task<ByteResult> HandlePrepareTypeHierarchyAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.PrepareTypeHierarchyAsync, ct);
    }

    private Task<ByteResult> HandleSupertypesAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetSupertypesAsync, ct);
    }

    private Task<ByteResult> HandleSubtypesAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetSubtypesAsync, ct);
    }
}
