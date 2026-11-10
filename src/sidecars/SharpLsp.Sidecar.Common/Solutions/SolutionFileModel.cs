using MessagePack;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Neutral solution-file model used by SharpLsp sidecars and the Rust host.
/// </summary>
/// <param name="Path">Absolute path to the solution file.</param>
/// <param name="Format">Solution file format: <c>sln</c> or <c>slnx</c>.</param>
/// <param name="Projects">Projects in solution declaration order.</param>
/// <param name="Folders">Solution folders in declaration order.</param>
/// <param name="Files">Solution item files declared under solution folders.</param>
[MessagePackObject]
public sealed record SolutionFileModel(
    [property: Key("path")] string Path,
    [property: Key("format")] string Format,
    [property: Key("projects")] IReadOnlyList<SolutionProjectEntry> Projects,
    [property: Key("folders")] IReadOnlyList<SolutionFolderEntry> Folders,
    [property: Key("files")] IReadOnlyList<SolutionItemEntry> Files
);

/// <summary>
/// Project entry declared by a legacy <c>.sln</c> or XML <c>.slnx</c> solution.
/// </summary>
/// <param name="DisplayName">Project display name from the solution model.</param>
/// <param name="Path">Absolute project file path.</param>
/// <param name="RelativePath">Original solution-relative project path.</param>
/// <param name="ProjectType">Project type name, project type ID, or file extension.</param>
/// <param name="Identity">Stable solution identity exposed by the model.</param>
/// <param name="ParentFolder">Name of the parent solution folder, if any.</param>
/// <param name="ParentFolderPath">Path of the parent solution folder, if any.</param>
/// <param name="DeclarationOrder">Zero-based project declaration order.</param>
[MessagePackObject]
public sealed record SolutionProjectEntry(
    [property: Key("displayName")] string DisplayName,
    [property: Key("path")] string Path,
    [property: Key("relativePath")] string RelativePath,
    [property: Key("projectType")] string ProjectType,
    [property: Key("identity")] string Identity,
    [property: Key("parentFolder")] string? ParentFolder,
    [property: Key("parentFolderPath")] string? ParentFolderPath,
    [property: Key("declarationOrder")] int DeclarationOrder
);

/// <summary>
/// Solution folder entry declared by a legacy <c>.sln</c> or XML <c>.slnx</c> solution.
/// </summary>
/// <param name="Name">Display name of the solution folder.</param>
/// <param name="Path">Slash-delimited solution-folder path, such as <c>/src/</c>.</param>
/// <param name="Identity">Stable solution identity exposed by the model.</param>
/// <param name="ParentPath">Parent solution-folder path, if nested.</param>
/// <param name="ParentName">Parent solution-folder name, if nested.</param>
/// <param name="DeclarationOrder">Zero-based folder declaration order.</param>
[MessagePackObject]
public sealed record SolutionFolderEntry(
    [property: Key("name")] string Name,
    [property: Key("path")] string Path,
    [property: Key("identity")] string Identity,
    [property: Key("parentPath")] string? ParentPath,
    [property: Key("parentName")] string? ParentName,
    [property: Key("declarationOrder")] int DeclarationOrder
);

/// <summary>
/// Solution item file declared under a solution folder.
/// </summary>
/// <param name="Path">Absolute solution item path.</param>
/// <param name="RelativePath">Original solution-relative item path.</param>
/// <param name="ParentFolder">Name of the parent solution folder, if any.</param>
/// <param name="ParentFolderPath">Path of the parent solution folder, if any.</param>
/// <param name="DeclarationOrder">Zero-based solution item declaration order.</param>
[MessagePackObject]
public sealed record SolutionItemEntry(
    [property: Key("path")] string Path,
    [property: Key("relativePath")] string RelativePath,
    [property: Key("parentFolder")] string? ParentFolder,
    [property: Key("parentFolderPath")] string? ParentFolderPath,
    [property: Key("declarationOrder")] int DeclarationOrder
);
