using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for MSBuild package-reference editing (GitHub #4, [NUGET-XML-DOM]).
/// The Rust host decides which file + element kind to edit and delegates the
/// actual XML mutation here so it goes through the real MSBuild document model.
/// </summary>
internal sealed partial class CSharpSidecar
{
    private Task<ByteResult> HandleAddPackageAsync(byte[] payload, CancellationToken ct)
    {
        return Task.FromResult(EditPackage(payload, PackageEditor.Add, ct));
    }

    private Task<ByteResult> HandleRemovePackageAsync(byte[] payload, CancellationToken ct)
    {
        return Task.FromResult(EditPackage(payload, PackageEditor.Remove, ct));
    }

    private static ByteResult EditPackage(
        byte[] payload,
        Func<PackageEditRequest, PackageEditResult> edit,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PackageEditRequest>(
                payload,
                cancellationToken: ct
            );
            var result = edit(request);
            var bytes = MessagePackSerializer.Serialize(result, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
