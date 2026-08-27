using MessagePack;
using SharpLsp.Sidecar.CSharp.Debugging;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

internal sealed partial class CSharpSidecar
{
    private readonly HotReloadSessionRegistry _hotReload = new();

    private async Task<ByteResult> HandleHotReloadAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<HotReloadRequest>(
                payload,
                cancellationToken: ct
            );
            var response = await _hotReload.HandleAsync(request, ct).ConfigureAwait(false);
            var bytes = MessagePackSerializer.Serialize(response, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class HotReloadRequest
{
    [Key(0)]
    public string Action { get; set; } = "";

    [Key(1)]
    public string? SessionId { get; set; }

    [Key(2)]
    public string? ProjectPath { get; set; }

    [Key(3)]
    public string? FilePath { get; set; }

    [Key(4)]
    public string? NewText { get; set; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class HotReloadResponse
{
    [Key(0)]
    public string Status { get; set; } = "";

    [Key(1)]
    public string SessionId { get; set; } = "";

    [Key(2)]
    public string AssemblyName { get; set; } = "";

    [Key(3)]
    public List<HotReloadDelta> Updates { get; set; } = [];

    [Key(4)]
    public List<string> Diagnostics { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class HotReloadDelta
{
    [Key(0)]
    public string ModuleId { get; set; } = "";

    [Key(1)]
    public string MetadataDelta { get; set; } = "";

    [Key(2)]
    public string IlDelta { get; set; } = "";

    [Key(3)]
    public string PdbDelta { get; set; } = "";
}
