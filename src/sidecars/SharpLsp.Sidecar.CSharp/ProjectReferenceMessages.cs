using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// <c>project/addProjectReference</c>: the project that gains a reference and the project it
/// references. Answered with a <see cref="PackageEditResult"/>, the modified/message contract the
/// other project-file edits share. Positional keys mirror the Rust host.
/// [REFACTOR-IMPORT-REFERENCE]
/// </summary>
[MessagePackObject(AllowPrivate = true)]
internal sealed class ProjectReferenceRequest
{
    /// <summary>Absolute path of the project file that gains the reference.</summary>
    [Key(0)]
    public string FilePath { get; set; } = "";

    /// <summary>Absolute path of the referenced project file.</summary>
    [Key(1)]
    public string ReferencePath { get; set; } = "";
}
