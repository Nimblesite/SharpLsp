using MessagePack;

namespace SharpLsp.Sidecar.Common.Messages;

/// <summary>
/// <c>workspace/targetFramework</c> and <c>workspace/setTargetFramework</c>: the
/// document whose project is asked about, and — to switch — the framework to make
/// active. Positional keys mirror the Rust host. Implements [NETFX-CONTEXT].
/// </summary>
[MessagePackObject]
public sealed class TargetFrameworkRequest
{
    /// <summary>Absolute path of a document of the project.</summary>
    [Key(0)]
    public string FilePath { get; set; } = "";

    /// <summary>The framework to make active; null only asks.</summary>
    [Key(1)]
    public string? TargetFramework { get; set; }
}

/// <summary>A project's active framework and every framework it targets.</summary>
[MessagePackObject]
public sealed class TargetFrameworkResult
{
    /// <summary>The framework requests answer from; null for a single-target project.</summary>
    [Key(0)]
    public string? Active { get; set; }

    /// <summary>Every framework, in <c>&lt;TargetFrameworks&gt;</c> order; empty when single-target.</summary>
    [Key(1)]
    public IReadOnlyList<string> Available { get; set; } = [];

    /// <summary>Absolute path of the project file; null when no project owns the document.</summary>
    [Key(2)]
    public string? Project { get; set; }
}
