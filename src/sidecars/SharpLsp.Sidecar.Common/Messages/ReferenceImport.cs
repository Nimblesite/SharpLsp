using MessagePack;

namespace SharpLsp.Sidecar.Common.Messages;

/// <summary>
/// The reference a quick fix adds before its import: another project of the solution, or a
/// package. A code action carrying one is a command action; the host adds the reference, then
/// resolves the action for the import edit. Positional keys mirror the Rust host.
/// Implements [REFACTOR-IMPORT-REFERENCE].
/// </summary>
[MessagePackObject]
public sealed class ReferenceImport
{
    /// <summary>The kind of a reference to another project of the solution.</summary>
    public const string ProjectKind = "project";

    /// <summary>The kind of a NuGet package reference.</summary>
    public const string PackageKind = "package";

    /// <summary><see cref="ProjectKind"/> or <see cref="PackageKind"/>.</summary>
    [Key(0)]
    public string Kind { get; set; } = "";

    /// <summary>Absolute path of the project file that gains the reference.</summary>
    [Key(1)]
    public string ProjectPath { get; set; } = "";

    /// <summary>The referenced project's absolute path, or the package id.</summary>
    [Key(2)]
    public string Reference { get; set; } = "";

    /// <summary>The package version; empty for a project, or for the latest stable package.</summary>
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
}
