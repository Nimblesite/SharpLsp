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

    /// <summary>
    /// <c>server.debounce_ms</c>: how long a directive edit waits before its reload. Null, from
    /// an older host, reloads at once. [SCRIPT-RELOAD]
    /// </summary>
    [Key(3)]
    public int? ReloadDebounceMs { get; set; }

    /// <summary>
    /// <c>fsharp.script_arguments</c>: extra compiler arguments every F# script is checked
    /// with. Null, from an older host, is none. [SCRIPT-FSX-ARGUMENTS]
    /// </summary>
    [Key(4)]
    public IReadOnlyList<string>? ScriptArguments { get; set; }
}
