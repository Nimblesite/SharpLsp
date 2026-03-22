using Forge.Sidecar.Common.Messages;
using MessagePack;

namespace Forge.Sidecar.Common.Tests;

public sealed class EnvelopeTests
{
    [Fact]
    public void Roundtrip_request_preserves_all_fields()
    {
        var original = new Envelope
        {
            Id = 42,
            Method = "textDocument/hover",
            Payload = [0x01, 0x02, 0x03],
        };

        var bytes = MessagePackSerializer.Serialize(original);
        var deserialized = MessagePackSerializer.Deserialize<Envelope>(bytes);

        Assert.Equal(original.Id, deserialized.Id);
        Assert.Equal(original.Method, deserialized.Method);
        Assert.Equal(original.Payload, deserialized.Payload);
        Assert.Null(deserialized.Error);
    }

    [Fact]
    public void Roundtrip_notification_has_null_id()
    {
        var original = new Envelope
        {
            Method = "workspace/open",
            Payload = [0xFF],
        };

        var bytes = MessagePackSerializer.Serialize(original);
        var deserialized = MessagePackSerializer.Deserialize<Envelope>(bytes);

        Assert.Null(deserialized.Id);
        Assert.Equal("workspace/open", deserialized.Method);
    }

    [Fact]
    public void Roundtrip_error_response_preserves_error()
    {
        var original = new Envelope
        {
            Id = 7,
            Error = "something went wrong",
        };

        var bytes = MessagePackSerializer.Serialize(original);
        var deserialized = MessagePackSerializer.Deserialize<Envelope>(bytes);

        Assert.Equal((uint)7, deserialized.Id);
        Assert.Equal("something went wrong", deserialized.Error);
        Assert.Null(deserialized.Method);
    }

    [Fact]
    public void Roundtrip_empty_payload_is_empty_array()
    {
        var original = new Envelope { Id = 1 };

        var bytes = MessagePackSerializer.Serialize(original);
        var deserialized = MessagePackSerializer.Deserialize<Envelope>(bytes);

        Assert.Empty(deserialized.Payload);
    }
}
