using System.Collections.Concurrent;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;
using FrameworkResult = Outcome.Result<
    SharpLsp.Sidecar.Common.Messages.TargetFrameworkResult,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>The active target framework per project file. Implements [NETFX-CONTEXT].</summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>Project file path → the framework the user made active.</summary>
    private readonly ConcurrentDictionary<string, string> _activeFrameworks = new(
        NativePaths.Comparer
    );

    /// <summary>
    /// The active framework and the frameworks of the project owning a document; nothing to
    /// choose, and no project, for a document no loaded project compiles.
    /// </summary>
    public async Task<FrameworkResult> GetTargetFrameworksAsync(
        string filePath,
        CancellationToken ct
    )
    {
        var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
        if (document is null || _solution is null)
        {
            return new FrameworkResult.Ok<TargetFrameworkResult, string>(
                new TargetFrameworkResult()
            );
        }

        var available = TargetFrameworks
            .ContextsOf(_solution, document.Project)
            .Select(TargetFrameworks.FrameworkOf)
            .OfType<string>()
            .ToList();
        var active =
            available.Count == 0
                ? null
                : TargetFrameworks.ActiveFramework(_solution, document.Project, _activeFrameworks);
        return new FrameworkResult.Ok<TargetFrameworkResult, string>(
            new TargetFrameworkResult
            {
                Active = active,
                Available = available,
                Project = document.Project.FilePath,
            }
        );
    }

    /// <summary>Make <paramref name="framework"/> the active context of the document's project.</summary>
    public async Task<FrameworkResult> SetTargetFrameworkAsync(
        string filePath,
        string framework,
        CancellationToken ct
    )
    {
        var current = await GetTargetFrameworksAsync(filePath, ct).ConfigureAwait(false);
        if (current is not FrameworkResult.Ok<TargetFrameworkResult, string> ok)
        {
            return current;
        }

        var projectFile = (await FindDocumentAsync(filePath, ct).ConfigureAwait(false))
            ?.Project
            .FilePath;
        if (projectFile is null || !ok.Value.Available.Contains(framework, StringComparer.Ordinal))
        {
            return FrameworkResult.Failure(
                $"{framework} is not a target framework of {(projectFile is null ? filePath : NativePaths.NameOf(projectFile))}"
            );
        }

        _activeFrameworks[projectFile] = framework;
        return await GetTargetFrameworksAsync(filePath, ct).ConfigureAwait(false);
    }
}
