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
        Assert.Null(actual.ReloadDebounceMs);
        Assert.Null(actual.ScriptArguments);
        object?[] wire = [false, true, restore, null, null];
        Assert.Equal(
            wire,
            MessagePackSerializer.Deserialize<object?[]>(MessagePackSerializer.Serialize(actual))
        );
    }

    /// <summary>The directive reload window follows the three flags. [SCRIPT-RELOAD]</summary>
    [Theory]
    [InlineData(0)]
    [InlineData(150)]
    [InlineData(60_000)]
    public void The_reload_debounce_is_the_fourth_field(int debounceMs)
    {
        object[] fields = [true, true, false, debounceMs];
        var bytes = MessagePackSerializer.Serialize(fields);
        var actual = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(bytes);
        Assert.True(actual.AnalyzersEnabled);
        Assert.True(actual.RefreshSupported);
        Assert.False(actual.AutoRestoreOnOpen);
        Assert.Equal(debounceMs, actual.ReloadDebounceMs);
        var roundTrip = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(
            MessagePackSerializer.Serialize(actual)
        );
        Assert.Equal(debounceMs, roundTrip.ReloadDebounceMs);
        Assert.False(roundTrip.AutoRestoreOnOpen);
    }

    /// <summary>Script arguments follow the reload window. [SCRIPT-FSX-ARGUMENTS]</summary>
    [Fact]
    public void Script_arguments_are_the_fifth_field_in_order()
    {
        string[] arguments = ["--define:CI", "--langversion:preview", "--nowarn:25"];
        object[] fields = [true, true, true, 150, arguments];
        var bytes = MessagePackSerializer.Serialize(fields);
        var actual = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(bytes);
        Assert.Equal(arguments, actual.ScriptArguments);
        Assert.Equal(150, actual.ReloadDebounceMs);
        Assert.True(actual.AutoRestoreOnOpen);
        var roundTrip = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(
            MessagePackSerializer.Serialize(actual)
        );
        Assert.Equal(arguments, roundTrip.ScriptArguments);
        object[] none = [true, true, true, 150, Array.Empty<string>()];
        var empty = MessagePackSerializer.Deserialize<DiagnosticsConfiguration>(
            MessagePackSerializer.Serialize(none)
        );
        Assert.NotNull(empty.ScriptArguments);
        Assert.Empty(empty.ScriptArguments);
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
        Assert.Null(actual.ReloadDebounceMs);
    }
}
