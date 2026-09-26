using System.Xml.Linq;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Resolves a project's <c>&lt;ProjectReference&gt;</c> entries and their built
/// output assemblies.
///
/// Shared by the C# and F# sidecars. Roslyn's <c>MSBuildWorkspace</c> does not wire
/// a project reference that crosses the language boundary, so the C# sidecar sees an
/// F# project as its built DLL, located here; the F# sidecar compiles the C# projects
/// it references in memory ([SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES])
/// and falls back to the DLL located here when it cannot. Implements [DEFINITION-CROSSLANG].
/// </summary>
public static class ProjectReferences
{
    /// <summary>
    /// Absolute paths of every project referenced by <paramref name="projectFilePath"/>
    /// through <c>&lt;ProjectReference Include="..." /&gt;</c>. A missing or
    /// malformed project file yields an empty list rather than throwing.
    /// </summary>
    public static IReadOnlyList<string> ReadReferencedProjects(string projectFilePath)
    {
        try
        {
            var projectDir = NativePaths.DirectoryOf(projectFilePath);
            var doc = XDocument.Load(projectFilePath);
            return
            [
                .. doc.Descendants()
                    .Where(element => element.Name.LocalName == "ProjectReference")
                    .Select(element => element.Attribute("Include")?.Value)
                    .Where(include => !string.IsNullOrWhiteSpace(include))
                    .Select(include => NativePaths.Resolve(projectDir, include!)),
            ];
        }
        catch (Exception)
        {
            return [];
        }
    }

    /// <summary>
    /// Newest built output assembly under the project's <c>bin</c> tree, or
    /// <see langword="null"/> when the project has never been built. The
    /// assembly's simple name comes from <c>&lt;AssemblyName&gt;</c> when set,
    /// otherwise the project file's stem.
    /// </summary>
    public static string? FindOutputAssembly(string projectFilePath)
    {
        try
        {
            var binDir = NativePaths.Resolve(NativePaths.DirectoryOf(projectFilePath), "bin");
            if (!Directory.Exists(binDir))
            {
                return null;
            }

            var dllName = AssemblyName(projectFilePath) + ".dll";
            return Directory
                .EnumerateFiles(binDir, dllName, SearchOption.AllDirectories)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Simple assembly name: <c>&lt;AssemblyName&gt;</c> or the file stem.</summary>
    private static string AssemblyName(string projectFilePath)
    {
        try
        {
            var explicitName = XDocument
                .Load(projectFilePath)
                .Descendants()
                .FirstOrDefault(element => element.Name.LocalName == "AssemblyName")
                ?.Value;
            return string.IsNullOrWhiteSpace(explicitName)
                ? NativePaths.StemOf(projectFilePath)
                : explicitName;
        }
        catch (Exception)
        {
            return NativePaths.StemOf(projectFilePath);
        }
    }
}
