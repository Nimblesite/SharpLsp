using System.Collections.Concurrent;

namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// The projects of a workspace that a project in the OTHER .NET language references: a
/// C# project an F# project calls into, or an F# project a C# project calls into.
///
/// Neither compiler sees the other language's callers, so neither dead-code analyzer can
/// prove a public symbol of such a project unused: [ANALYZERS-TRUTH] prefers silence to a
/// false error, so these projects report no unused PUBLIC code (#617). Private and
/// internal code stays the declaring compiler's to judge.
///
/// A compiler never reloads for the other language's project edits, so each project's
/// references are re-read whenever its file has been written since they were last read.
/// </summary>
public sealed class CrossLanguageReferences
{
    private readonly IReadOnlyList<string> _projects;
    private readonly ConcurrentDictionary<string, Read> _read = new(NativePaths.Comparer);

    private CrossLanguageReferences(IReadOnlyList<string> projects)
    {
        _projects = projects;
    }

    /// <summary>No workspace: nothing is referenced across languages.</summary>
    public static CrossLanguageReferences None { get; } = new([]);

    /// <summary>The projects of <paramref name="target"/> — a solution, a project file or a folder.</summary>
    public static async Task<CrossLanguageReferences> OfAsync(string target, CancellationToken ct)
    {
        return new(await ProjectsOfAsync(target, ct).ConfigureAwait(false));
    }

    /// <summary>True when a project of the other language references <paramref name="project"/> now.</summary>
    public bool Contains(string project)
    {
        return _projects.Any(referencing =>
            IsFSharp(referencing) != IsFSharp(project)
            && ReferencesOf(referencing).Contains(project, NativePaths.Comparer)
        );
    }

    /// <summary>The projects <paramref name="project"/> references, re-read when its file changed.</summary>
    private IReadOnlyList<string> ReferencesOf(string project)
    {
        var written = File.GetLastWriteTimeUtc(project);
        return _read
            .AddOrUpdate(
                project,
                _ => new(written, ProjectReferences.ReadReferencedProjects(project)),
                (_, known) =>
                    known.Written == written
                        ? known
                        : new(written, ProjectReferences.ReadReferencedProjects(project))
            )
            .Referenced;
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

    /// <summary>A project's references as of the write time they were read at.</summary>
    private sealed record Read(DateTime Written, IReadOnlyList<string> Referenced);
}
