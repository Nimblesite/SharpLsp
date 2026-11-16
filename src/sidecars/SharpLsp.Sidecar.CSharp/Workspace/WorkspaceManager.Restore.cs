namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>Only explicit workspace loads may restore stale SDK assets. [DIAG-RESTORE]</summary>
    internal bool AutoRestoreOnOpen { get; set; } = true;

    /// <summary>
    /// How long a file-based app's directive edit waits before its packages are restored, so a
    /// directive typed keystroke by keystroke restores once (<c>server.debounce_ms</c>).
    /// Implements [SCRIPT-RELOAD].
    /// </summary>
    internal TimeSpan DirectiveReloadDebounce { get; set; }

    /// <summary>File-based package restores begun since this workspace was created.</summary>
    internal long PackageRestores => Interlocked.Read(ref _packageRestores);

    private long _packageRestores;
}
