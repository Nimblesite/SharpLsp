using MessagePack;

namespace Forge.Sidecar.Common.Messages;

/// <summary>
/// Wire envelope for all sidecar IPC messages.
/// MessagePack-serializable, AOT-compatible via keyed attributes.
/// </summary>
[MessagePackObject]
public sealed class Envelope
{
    /// <summary>Request/response correlation ID. Null for notifications.</summary>
    [Key(0)]
    public uint? Id { get; init; }

    /// <summary>Method name for requests. Null for responses.</summary>
    [Key(1)]
    public string? Method { get; init; }

    /// <summary>MessagePack-encoded payload bytes.</summary>
    [Key(2)]
    public byte[] Payload { get; set; } = [];

    /// <summary>Error message, if this is an error response.</summary>
    [Key(3)]
    public string? Error { get; init; }
}
