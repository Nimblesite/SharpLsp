using System.Collections.Concurrent;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The target-framework dimension of a loaded solution. <c>MSBuildWorkspace</c>
/// loads one Roslyn project per framework of a multi-targeted project, named
/// <c>Name(tfm)</c> and in <c>&lt;TargetFrameworks&gt;</c> order, so one source
/// file is one document PER framework. Requests answer from the ACTIVE one: the
/// user's choice, else the first. Implements [NETFX-PROJECTS-CSHARP] and [NETFX-CONTEXT].
/// </summary>
internal static class TargetFrameworks
{
    /// <summary>The framework of a per-framework project; null for a single-target one.</summary>
    internal static string? FrameworkOf(Project project)
    {
        var name = project.Name;
        var open = name.LastIndexOf('(');
        return open > 0 && name.EndsWith(')') ? name[(open + 1)..^1] : null;
    }

    /// <summary>The per-framework projects built from <paramref name="project"/>'s file, in load order.</summary>
    internal static IEnumerable<Project> ContextsOf(Solution solution, Project project)
    {
        return solution.Projects.Where(candidate =>
            FrameworkOf(candidate) is not null
            && NativePaths.AreEqual(candidate.FilePath, project.FilePath)
        );
    }

    /// <summary>The framework a project file answers from: the chosen one, else its first.</summary>
    internal static string? ActiveFramework(
        Solution solution,
        Project project,
        ConcurrentDictionary<string, string> chosen
    )
    {
        return
            project.FilePath is not null && chosen.TryGetValue(project.FilePath, out var framework)
            ? framework
            : ContextsOf(solution, project).Select(FrameworkOf).FirstOrDefault();
    }

    /// <summary>True for a single-target project, or the active framework's project.</summary>
    internal static bool IsActive(
        Solution solution,
        Project project,
        ConcurrentDictionary<string, string> chosen
    )
    {
        return FrameworkOf(project) is not { } framework
            || framework == ActiveFramework(solution, project, chosen);
    }

    /// <summary>The document at <paramref name="filePath"/> in its project's active framework.</summary>
    internal static Document? FindActiveDocument(
        Solution solution,
        string filePath,
        ConcurrentDictionary<string, string> chosen
    )
    {
        var candidates = SolutionPaths.DocumentsAt(solution, filePath).ToList();
        return candidates.Find(document => IsActive(solution, document.Project, chosen))
            ?? candidates.FirstOrDefault();
    }

    /// <summary>
    /// <paramref name="text"/> applied to EVERY framework's copy of the document:
    /// an edit that reached only one context would leave the others stale.
    /// </summary>
    internal static Solution WithTextInEveryContext(
        Solution solution,
        Document document,
        SourceText text
    )
    {
        return document.FilePath is null
            ? solution.WithDocumentText(document.Id, text)
            : solution
                .GetDocumentIdsWithFilePath(document.FilePath)
                .Aggregate(solution, (current, id) => current.WithDocumentText(id, text));
    }
}
