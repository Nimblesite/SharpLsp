using MessagePack;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Neutral solution-file model used by SharpLsp sidecars and the Rust host.
/// </summary>
[MessagePackObject]
public sealed class SolutionFileModel
{
    /// <summary>Initializes a new instance of the <see cref="SolutionFileModel" /> class.</summary>
    [SerializationConstructor]
    public SolutionFileModel(
        string path,
        string format,
        IReadOnlyList<SolutionProjectEntry> projects,
        IReadOnlyList<SolutionFolderEntry> folders,
        IReadOnlyList<SolutionItemEntry> files
    )
    {
        Path = path;
        Format = format;
        Projects = projects;
        Folders = folders;
        Files = files;
    }

    /// <summary>Absolute path to the solution file.</summary>
    [Key("path")]
    public string Path { get; }

    /// <summary>Solution file format: <c>sln</c> or <c>slnx</c>.</summary>
    [Key("format")]
    public string Format { get; }

    /// <summary>Projects in solution declaration order.</summary>
    [Key("projects")]
    public IReadOnlyList<SolutionProjectEntry> Projects { get; }

    /// <summary>Solution folders in declaration order.</summary>
    [Key("folders")]
    public IReadOnlyList<SolutionFolderEntry> Folders { get; }

    /// <summary>Solution item files declared under solution folders.</summary>
    [Key("files")]
    public IReadOnlyList<SolutionItemEntry> Files { get; }
}

/// <summary>
/// Project entry declared by a legacy <c>.sln</c> or XML <c>.slnx</c> solution.
/// </summary>
[MessagePackObject]
public sealed class SolutionProjectEntry
{
    /// <summary>Initializes a new instance of the <see cref="SolutionProjectEntry" /> class.</summary>
    [SerializationConstructor]
    public SolutionProjectEntry(
        string displayName,
        string path,
        string relativePath,
        string projectType,
        string identity,
        string? parentFolder,
        string? parentFolderPath,
        int declarationOrder
    )
    {
        DisplayName = displayName;
        Path = path;
        RelativePath = relativePath;
        ProjectType = projectType;
        Identity = identity;
        ParentFolder = parentFolder;
        ParentFolderPath = parentFolderPath;
        DeclarationOrder = declarationOrder;
    }

    /// <summary>Project display name from the solution model.</summary>
    [Key("displayName")]
    public string DisplayName { get; }

    /// <summary>Absolute project file path.</summary>
    [Key("path")]
    public string Path { get; }

    /// <summary>Original solution-relative project path.</summary>
    [Key("relativePath")]
    public string RelativePath { get; }

    /// <summary>Project type name, project type ID, or file extension.</summary>
    [Key("projectType")]
    public string ProjectType { get; }

    /// <summary>Stable solution identity exposed by the model.</summary>
    [Key("identity")]
    public string Identity { get; }

    /// <summary>Name of the parent solution folder, if any.</summary>
    [Key("parentFolder")]
    public string? ParentFolder { get; }

    /// <summary>Path of the parent solution folder, if any.</summary>
    [Key("parentFolderPath")]
    public string? ParentFolderPath { get; }

    /// <summary>Zero-based project declaration order.</summary>
    [Key("declarationOrder")]
    public int DeclarationOrder { get; }
}

/// <summary>
/// Solution folder entry declared by a legacy <c>.sln</c> or XML <c>.slnx</c> solution.
/// </summary>
[MessagePackObject]
public sealed class SolutionFolderEntry
{
    /// <summary>Initializes a new instance of the <see cref="SolutionFolderEntry" /> class.</summary>
    [SerializationConstructor]
    public SolutionFolderEntry(
        string name,
        string path,
        string identity,
        string? parentPath,
        string? parentName,
        int declarationOrder
    )
    {
        Name = name;
        Path = path;
        Identity = identity;
        ParentPath = parentPath;
        ParentName = parentName;
        DeclarationOrder = declarationOrder;
    }

    /// <summary>Display name of the solution folder.</summary>
    [Key("name")]
    public string Name { get; }

    /// <summary>Slash-delimited solution-folder path, such as <c>/src/</c>.</summary>
    [Key("path")]
    public string Path { get; }

    /// <summary>Stable solution identity exposed by the model.</summary>
    [Key("identity")]
    public string Identity { get; }

    /// <summary>Parent solution-folder path, if nested.</summary>
    [Key("parentPath")]
    public string? ParentPath { get; }

    /// <summary>Parent solution-folder name, if nested.</summary>
    [Key("parentName")]
    public string? ParentName { get; }

    /// <summary>Zero-based folder declaration order.</summary>
    [Key("declarationOrder")]
    public int DeclarationOrder { get; }
}

/// <summary>
/// Solution item file declared under a solution folder.
/// </summary>
[MessagePackObject]
public sealed class SolutionItemEntry
{
    /// <summary>Initializes a new instance of the <see cref="SolutionItemEntry" /> class.</summary>
    [SerializationConstructor]
    public SolutionItemEntry(
        string path,
        string relativePath,
        string? parentFolder,
        string? parentFolderPath,
        int declarationOrder
    )
    {
        Path = path;
        RelativePath = relativePath;
        ParentFolder = parentFolder;
        ParentFolderPath = parentFolderPath;
        DeclarationOrder = declarationOrder;
    }

    /// <summary>Absolute solution item path.</summary>
    [Key("path")]
    public string Path { get; }

    /// <summary>Original solution-relative item path.</summary>
    [Key("relativePath")]
    public string RelativePath { get; }

    /// <summary>Name of the parent solution folder, if any.</summary>
    [Key("parentFolder")]
    public string? ParentFolder { get; }

    /// <summary>Path of the parent solution folder, if any.</summary>
    [Key("parentFolderPath")]
    public string? ParentFolderPath { get; }

    /// <summary>Zero-based solution item declaration order.</summary>
    [Key("declarationOrder")]
    public int DeclarationOrder { get; }
}
