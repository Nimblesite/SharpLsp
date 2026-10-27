using MessagePack;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Handlers for MSBuild project-file editing (GitHub #4 [NUGET-XML-DOM];
/// GitHub #493 [SE-ADD-FILE-REQUEST]). The Rust host decides which file to edit
/// and delegates the actual XML mutation here so it goes through the real MSBuild
/// document model — package entries and <c>Compile</c> items alike.
/// </summary>
internal sealed partial class CSharpSidecar
{
    /// <summary>The handler that applies <paramref name="edit"/> to each request it receives.</summary>
    private static Func<byte[], CancellationToken, Task<ByteResult>> ProjectFileEdit<TRequest>(
        Func<TRequest, PackageEditResult> edit
    )
        where TRequest : class
    {
        return (payload, ct) => Task.FromResult(EditProjectFile(payload, edit, ct));
    }

    /// <summary>
    /// Deserialize an edit request, run it, and serialize its result. Any failure
    /// (unreadable file, missing anchor, …) becomes a wire error for the host to
    /// surface through its own <c>Result</c>.
    /// </summary>
    private static ByteResult EditProjectFile<TRequest>(
        byte[] payload,
        Func<TRequest, PackageEditResult> edit,
        CancellationToken ct
    )
        where TRequest : class
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<TRequest>(
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
