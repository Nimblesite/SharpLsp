using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Solutions;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Loads a solution or project into Roslyn without ever design-time-building an F# project.
/// </summary>
/// <remarks>
/// Roslyn's <c>MSBuildWorkspace</c> loads every <c>.fsproj</c> it meets, whether a solution
/// lists it or a C# project references it, and loading one is a design-time build. That
/// build writes <c>obj/&lt;cfg&gt;/&lt;tfm&gt;/&lt;Name&gt;.AssemblyInfo.fs</c> while the F#
/// sidecar's own build of the project writes the same file, and the loser fails "being used
/// by another process" (#309 CI). The C# sidecar only ever discarded what it built: it reads
/// an F# project as the DLL <see cref="ProjectReferences.FindOutputAssembly"/> finds.
/// So every F# project reachable from the load is registered up front as an empty
/// placeholder in the <see cref="ProjectMap"/> Roslyn resolves projects through, and Roslyn
/// takes the placeholder instead of building. <see cref="WorkspaceManager"/> then swaps each
/// placeholder for that DLL, exactly as it did the stubs Roslyn used to build.
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-OWNERSHIP].
/// </remarks>
internal static class RoslynProjectLoading
{
    /// <summary>The project files Roslyn itself loads; an <c>.fsproj</c> is the F# sidecar's.</summary>
    private static readonly string[] RoslynProjects = [".csproj", ".vbproj"];

    /// <summary>Load <paramref name="target"/>, a solution or one project, with no F# built.</summary>
    internal static async Task<Solution> LoadAsync(
        MSBuildWorkspace workspace,
        string target,
        CancellationToken ct
    )
    {
        var entries = await EntriesAsync(target, ct).ConfigureAwait(false);
        var solution = WithPlaceholders(workspace.CurrentSolution, FSharpReachedFrom(entries));
        var map = ProjectMap.Create(solution);
        var loader = new MSBuildProjectLoader(workspace, PropertiesFor(workspace, target));
        foreach (var project in entries.Where(IsRoslynProject))
        {
            var infos = await loader
                .LoadProjectInfoAsync(project, map, cancellationToken: ct)
                .ConfigureAwait(false);
            solution = WithNew(solution, infos);
        }
        return solution;
    }

    /// <summary>Whether <paramref name="path"/> is a project Roslyn loads itself.</summary>
    private static bool IsRoslynProject(string path)
    {
        return RoslynProjects.Any(extension => NativePaths.HasExtension(path, extension))
            && File.Exists(path);
    }

    /// <summary>Every project a solution lists, or the one project asked for.</summary>
    private static async Task<IReadOnlyList<string>> EntriesAsync(
        string target,
        CancellationToken ct
    )
    {
        if (!SolutionFileReader.IsSolutionFile(target))
        {
            return [NativePaths.NormalizeFullPath(target)];
        }

        var read = await SolutionFileReader.ReadAsync(target, ct).ConfigureAwait(false);
        return read.Match(
            model => model.Projects.Select(project => project.Path).ToList(),
            error => throw new InvalidOperationException(error)
        );
    }

    /// <summary>
    /// Every F# project the load can reach: listed by the solution, or referenced by a
    /// project Roslyn loads, however many C# projects deep.
    /// </summary>
    private static HashSet<string> FSharpReachedFrom(IReadOnlyList<string> entries)
    {
        var seen = new HashSet<string>(NativePaths.Comparer);
        var pending = new Queue<string>(entries);
        while (pending.TryDequeue(out var project))
        {
            if (seen.Add(project) && IsRoslynProject(project))
            {
                foreach (var referenced in ProjectReferences.ReadReferencedProjects(project))
                {
                    pending.Enqueue(referenced);
                }
            }
        }
        return [.. seen.Where(path => NativePaths.HasExtension(path, ".fsproj"))];
    }

    /// <summary><paramref name="solution"/> holding one empty placeholder per F# project.</summary>
    private static Solution WithPlaceholders(Solution solution, HashSet<string> fsharp)
    {
        return fsharp.Aggregate(
            solution,
            (current, fsproj) => current.AddProject(Placeholder(fsproj))
        );
    }

    /// <summary>
    /// An F# project as Roslyn needs to know it and no more: its path, and the DLL a C#
    /// project references it through. Its language is C# only because Roslyn has no F#.
    /// </summary>
    private static ProjectInfo Placeholder(string fsproj)
    {
        var name = NativePaths.StemOf(fsproj);
        return ProjectInfo.Create(
            ProjectId.CreateNewId(debugName: fsproj),
            VersionStamp.Create(),
            name,
            name,
            LanguageNames.CSharp,
            filePath: fsproj,
            outputFilePath: ProjectReferences.FindOutputAssembly(fsproj)
        );
    }

    /// <summary>
    /// <paramref name="solution"/> with the projects of <paramref name="infos"/> it lacks: a
    /// project loaded as one project's reference comes back again when it is asked for.
    /// </summary>
    private static Solution WithNew(Solution solution, ImmutableArray<ProjectInfo> infos)
    {
        return infos
            .Where(info => solution.GetProject(info.Id) is null)
            .Aggregate(solution, (current, info) => current.AddProject(info));
    }

    /// <summary>
    /// The workspace's properties, plus <c>$(SolutionDir)</c> for a solution as MSBuild
    /// defines it when building one — some projects depend on it.
    /// </summary>
    private static ImmutableDictionary<string, string> PropertiesFor(
        MSBuildWorkspace workspace,
        string target
    )
    {
        return SolutionFileReader.IsSolutionFile(target)
            ? workspace.Properties.SetItem(
                "SolutionDir",
                NativePaths.AsDirectory(
                    NativePaths.DirectoryOf(NativePaths.NormalizeFullPath(target))
                )
            )
            : workspace.Properties;
    }
}
