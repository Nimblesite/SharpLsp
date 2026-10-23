using MessagePack;
using SharpLsp.Sidecar.Common.Messages;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>Restore policy preserves positional wire compatibility. [DIAG-RESTORE]</summary>
public sealed class DiagnosticsConfigurationTests
{
    private static readonly bool[] LegacyFlags = [true, false];

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Restore_policy_is_the_third_boolean_after_analyzers_and_refresh(bool restore)
    {
        bool[] flags = [false, true, restore];
        var bytes = MessagePackSerializer.Serialize(flags);
        var actual = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(bytes);
        Assert.False(actual.AnalyzersEnabled);
        Assert.True(actual.RefreshSupported);
        Assert.Equal(restore, actual.AutoRestoreOnOpen);
        Assert.Equal(
            flags,
            MessagePackSerializer.Deserialize<bool[]>(MessagePackSerializer.Serialize(actual))
        );
    }

    [Fact]
    public void An_older_two_field_host_keeps_workspace_restore_enabled()
    {
        var bytes = MessagePackSerializer.Serialize(LegacyFlags);
        var actual = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(bytes);
        Assert.True(actual.AnalyzersEnabled);
        Assert.False(actual.RefreshSupported);
        Assert.Null(actual.AutoRestoreOnOpen);
        Assert.True(actual.AutoRestoreOnOpen.GetValueOrDefault(true));
    }
}
