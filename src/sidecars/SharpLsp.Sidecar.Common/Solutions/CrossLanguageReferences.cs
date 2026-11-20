namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// The projects of a workspace that a project in the OTHER .NET language references: a
/// C# project an F# project calls into, or an F# project a C# project calls into.
///
/// Neither compiler sees the other language's callers, so neither dead-code analyzer can
/// prove a public symbol of such a project unused: [ANALYZERS-TRUTH] prefers silence to a
/// false error, so these projects report no unused PUBLIC code (#617). Private and
/// internal code stays the declaring compiler's to judge.
/// </summary>
public static class CrossLanguageReferences
{
    /// <summary>
    /// The project files of <paramref name="target"/> — a solution, a project file or a
    /// folder — that a project of the other language in that same target references.
    /// </summary>
    public static async Task<IReadOnlySet<string>> OfAsync(string target, CancellationToken ct)
    {
        return Across(await ProjectsOfAsync(target, ct).ConfigureAwait(false));
    }

    /// <summary>Every project in <paramref name="projects"/>' references written in the other language.</summary>
    public static IReadOnlySet<string> Across(IEnumerable<string> projects)
    {
        return projects
            .SelectMany(project =>
                ProjectReferences
                    .ReadReferencedProjects(project)
                    .Where(referenced => IsFSharp(referenced) != IsFSharp(project))
            )
            .ToHashSet(NativePaths.Comparer);
    }

    private static bool IsFSharp(string project)
    {
        return NativePaths.HasExtension(project, ".fsproj");
    }

    /// <summary>The project files a target holds, in both languages.</summary>
    private static async Task<IReadOnlyList<string>> ProjectsOfAsync(
        string target,
        CancellationToken ct
    )
    {
        if (SolutionFileReader.IsSolutionFile(target))
        {
            var read = await SolutionFileReader.ReadAsync(target, ct).ConfigureAwait(false);
            return read.Match<IReadOnlyList<string>>(
                solution => [.. solution.Projects.Select(project => project.Path)],
                _ => []
            );
        }
        return Directory.Exists(target) ? NativePaths.WorkspaceFiles(target, ".csproj", ".fsproj")
            : File.Exists(target) ? [target]
            : [];
    }
}
