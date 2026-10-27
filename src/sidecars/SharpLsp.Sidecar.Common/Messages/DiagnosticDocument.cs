using MessagePack;

namespace SharpLsp.Sidecar.Common.Messages;

/// <summary>
/// One source document of the loaded workspace, with the project that owns it.
/// The response item of the <c>workspace/diagnostics/documents</c> RPC both
/// sidecars answer: the host enumerates pull-diagnostics targets without eager
/// compilation ([DIAG-ARCHITECTURE-EAGER-SCAN]). Positional keys mirror the Rust
/// host's struct; shared so both engines emit one wire shape.
/// </summary>
[MessagePackObject]
public sealed class DiagnosticDocument
{
    /// <summary>Absolute native path of the source (or Razor) document.</summary>
    [Key(0)]
    public string FilePath { get; set; } = "";

    /// <summary>The owning project's display name (assembly/project name).</summary>
    [Key(1)]
    public string ProjectName { get; set; } = "";

    /// <summary>Absolute path of the owning project file.</summary>
    [Key(2)]
    public string ProjectPath { get; set; } = "";
}
