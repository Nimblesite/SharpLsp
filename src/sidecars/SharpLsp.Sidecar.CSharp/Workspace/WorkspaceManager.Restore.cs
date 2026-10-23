namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>Only explicit workspace loads may restore stale SDK assets. [DIAG-RESTORE]</summary>
    internal bool AutoRestoreOnOpen { get; set; } = true;
}
