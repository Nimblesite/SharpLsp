using MessagePack;

namespace SharpLsp.Sidecar.Common.Messages;

/// <summary>Diagnostic policy and negotiated invalidation support. [DIAG-IPC-REFRESH]</summary>
[MessagePackObject]
public sealed class DiagnosticsConfiguration
{
    /// <summary>Compiler diagnostics remain active when analyzers are disabled.</summary>
    [Key(0)]
    public bool AnalyzersEnabled { get; set; } = true;

    /// <summary>Older hosts do not accept unsolicited IPC envelopes.</summary>
    [Key(1)]
    public bool RefreshSupported { get; set; }

    /// <summary>Null preserves the default for older two-field hosts. [DIAG-RESTORE]</summary>
    [Key(2)]
    public bool? AutoRestoreOnOpen { get; set; }
}
