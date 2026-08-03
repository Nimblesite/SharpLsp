using System.Xml.Linq;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Resolves a project's <c>&lt;ProjectReference&gt;</c> entries and their built
/// output assemblies.
///
/// Shared by the C# and F# sidecars: each engine sees the *other* language only
/// as a compiled assembly, and neither Roslyn's <c>MSBuildWorkspace</c> nor FCS
/// wires up a project reference that crosses the language boundary. Both
/// sidecars use this to locate the referenced project's output DLL and add it as
/// a metadata reference, which is what makes cross-language go-to-definition
/// resolve. Implements [DEFINITION-CROSSLANG].
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
            var projectDir = Path.GetDirectoryName(projectFilePath) ?? ".";
            var doc = XDocument.Load(projectFilePath);
            return
            [
                .. doc.Descendants()
                    .Where(element => element.Name.LocalName == "ProjectReference")
                    .Select(element => element.Attribute("Include")?.Value)
                    .Where(include => !string.IsNullOrWhiteSpace(include))
                    .Select(include =>
                        Path.GetFullPath(Path.Combine(projectDir, NormalizeSeparators(include!)))
                    ),
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
            var projectDir = Path.GetDirectoryName(projectFilePath);
            if (projectDir is null)
            {
                return null;
            }

            var binDir = Path.Combine(projectDir, "bin");
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
                ? Path.GetFileNameWithoutExtension(projectFilePath)
                : explicitName;
        }
        catch (Exception)
        {
            return Path.GetFileNameWithoutExtension(projectFilePath);
        }
    }

    private static string NormalizeSeparators(string path)
    {
        return path.Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar);
    }
}
