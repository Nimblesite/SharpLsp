using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Path-keyed lookups over a Roslyn <see cref="Solution"/>. Single home for
/// the "which document / project is this native path?" question so every
/// feature agrees on path identity (<see cref="NativePaths"/>): the host
/// canonicalizes paths, which on Windows yields <c>\\?\</c>-prefixed
/// spellings that must still resolve. [GitHub #110]
/// </summary>
internal static class SolutionPaths
{
    /// <summary>Find a regular (non-generated) document by file path.</summary>
    internal static Document? FindDocument(Solution solution, string filePath)
    {
        return solution
            .Projects.SelectMany(project => project.Documents)
            .FirstOrDefault(document => NativePaths.AreEqual(document.FilePath, filePath));
    }

    /// <summary>Find a loaded project by its project-file path.</summary>
    internal static Project? FindProject(Solution solution, string projectPath)
    {
        return solution.Projects.FirstOrDefault(project =>
            NativePaths.AreEqual(project.FilePath, projectPath)
        );
    }
}
