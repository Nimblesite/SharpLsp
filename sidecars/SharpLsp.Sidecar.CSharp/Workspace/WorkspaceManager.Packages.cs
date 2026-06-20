using Microsoft.CodeAnalysis;
using ReferenceUsageQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.ReferenceUsageResult,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Implements [PKG-UNUSED-DETECT-CS]: assembly-level reference usage for a
/// project, via Roslyn's <c>Compilation.GetUsedAssemblyReferences()</c>.
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Classify a project's metadata references into used / all, plus the NuGet
    /// global packages folder so the host can map assemblies back to packages.
    /// </summary>
    public async Task<ReferenceUsageQueryResult> GetReferenceUsageAsync(
        string projectPath,
        CancellationToken ct = default
    )
    {
        try
        {
            if (_solution is null)
            {
                return ReferenceUsageQueryResult.Failure("No solution loaded");
            }

            var project = FindProjectByPath(projectPath);
            if (project is null)
            {
                return ReferenceUsageQueryResult.Failure($"Project not loaded: {projectPath}");
            }

            var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
            if (compilation is null)
            {
                return ReferenceUsageQueryResult.Failure("No compilation available");
            }

            var used = compilation.GetUsedAssemblyReferences(ct);
            var result = new ReferenceUsageResult
            {
                UsedPaths = PortablePaths(used),
                AllPaths = PortablePaths(compilation.References),
                PackagesRoot = GlobalPackagesFolder(),
            };
            return new ReferenceUsageQueryResult.Ok<ReferenceUsageResult, string>(result);
        }
        catch (Exception ex)
        {
            return ReferenceUsageQueryResult.Failure(ex.Message);
        }
    }

    /// <summary>Find a loaded project by its file path.</summary>
    private Project? FindProjectByPath(string projectPath)
    {
        var normalized = Path.GetFullPath(projectPath);
        return _solution!.Projects.FirstOrDefault(project =>
            IsPathMatch(project.FilePath, normalized)
        );
    }

    /// <summary>Absolute file paths of on-disk (PE) metadata references.</summary>
    private static string[] PortablePaths(IEnumerable<MetadataReference> references)
    {
        return
        [
            .. references
                .OfType<PortableExecutableReference>()
                .Select(reference => reference.FilePath)
                .Where(path => !string.IsNullOrEmpty(path))
                .Select(path => path!),
        ];
    }

    /// <summary>The NuGet global packages folder (env override or user default).</summary>
    private static string GlobalPackagesFolder()
    {
        var root = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        if (!string.IsNullOrEmpty(root))
        {
            return root;
        }

        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(home, ".nuget", "packages");
    }
}
