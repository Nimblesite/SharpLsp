using MessagePack;

namespace SharpLsp.Sidecar.Common.Messages;

/// <summary>
/// The project-file change a quick fix needs besides its text edit: a reference to another
/// project of the solution or to a package, added after the import, or a Compile item moved
/// earlier in F# compile order. A code action carrying one is a command action; the host makes
/// the change through the MSBuild DOM. Positional keys mirror the Rust host.
/// Implements [REFACTOR-IMPORT-REFERENCE] and [REFACTOR-FSHARP-FILE-ORDER].
/// </summary>
[MessagePackObject]
public sealed class ReferenceImport
{
    /// <summary>The kind of a reference to another project of the solution.</summary>
    public const string ProjectKind = "project";

    /// <summary>The kind of a NuGet package reference.</summary>
    public const string PackageKind = "package";

    /// <summary>The kind of a Compile item moved above another one.</summary>
    public const string CompileOrderKind = "compileOrder";

    /// <summary><see cref="ProjectKind"/>, <see cref="PackageKind"/> or <see cref="CompileOrderKind"/>.</summary>
    [Key(0)]
    public string Kind { get; set; } = "";

    /// <summary>Absolute path of the project file the host edits.</summary>
    [Key(1)]
    public string ProjectPath { get; set; } = "";

    /// <summary>The referenced project's absolute path, the package id, or the include of the Compile item to move.</summary>
    [Key(2)]
    public string Reference { get; set; } = "";

    /// <summary>
    /// The package version (empty for the latest stable one); empty for a project; for a
    /// compile-order move, the include of the Compile item the moved one lands above.
    /// </summary>
    [Key(3)]
    public string Version { get; set; } = "";

    /// <summary>A reference from <paramref name="projectPath"/> to <paramref name="referenced"/>.</summary>
    public static ReferenceImport ToProject(string projectPath, string referenced)
    {
        return new ReferenceImport
        {
            Kind = ProjectKind,
            ProjectPath = projectPath,
            Reference = referenced,
        };
    }

    /// <summary>Package <paramref name="id"/> at <paramref name="version"/> (empty: latest stable).</summary>
    public static ReferenceImport ToPackage(string projectPath, string id, string version)
    {
        return new ReferenceImport
        {
            Kind = PackageKind,
            ProjectPath = projectPath,
            Reference = id,
            Version = version,
        };
    }

    /// <summary>Compile item <paramref name="include"/> moved directly above <paramref name="above"/>.</summary>
    public static ReferenceImport ToCompileOrder(string projectPath, string include, string above)
    {
        return new ReferenceImport
        {
            Kind = CompileOrderKind,
            ProjectPath = projectPath,
            Reference = include,
            Version = above,
        };
    }
}
