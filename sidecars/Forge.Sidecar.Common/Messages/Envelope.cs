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
    [Key("id")]
    public uint? Id { get; init; }

    /// <summary>Method name for requests. Null for responses.</summary>
    [Key("method")]
    public string? Method { get; init; }

    /// <summary>MessagePack-encoded payload bytes. Array required by MessagePack serialization.</summary>
    [Key("payload")]
    [System.Diagnostics.CodeAnalysis.SuppressMessage(
        "Performance",
        "CA1819:Properties should not return arrays",
        Justification = "MessagePack serialization requires byte[]"
    )]
    public byte[] Payload { get; set; } = [];

    /// <summary>Error message, if this is an error response.</summary>
    [Key("error")]
    public string? Error { get; init; }
}
