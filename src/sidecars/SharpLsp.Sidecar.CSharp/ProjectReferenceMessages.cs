using MessagePack;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// <c>project/addProjectReference</c>: the project that gains a reference and the project it
/// references. Answered with a <see cref="PackageEditResult"/>, the modified/message contract the
/// other project-file edits share. Positional keys mirror the Rust host.
/// [REFACTOR-IMPORT-REFERENCE]
/// </summary>
/// <param name="FilePath">Absolute path of the project file that gains the reference.</param>
/// <param name="ReferencePath">Absolute path of the referenced project file.</param>
[MessagePackObject(AllowPrivate = true)]
internal sealed record ProjectReferenceRequest(
    [property: Key(0)] string FilePath,
    [property: Key(1)] string ReferencePath
);
