using System.Collections.Concurrent;
using Serilog;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Loads the project that owns a C# file no loaded project compiles, beside the workspace's
/// own projects, so a file opened from outside the solution still answers (GitHub #414).
/// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>The owning-project loads in flight, so a burst of edits loads each owner once.</summary>
    private readonly ConcurrentDictionary<string, Task> _owningLoads = new(NativePaths.Comparer);

    /// <summary>
    /// Start loading the project that owns <paramref name="filePath"/>, holding
    /// <paramref name="newText"/> until it lands. False when no unloaded project owns it.
    /// The caller holds <see cref="_solutionMutationLock" />.
    /// </summary>
    private bool AdoptOwner(string filePath, string newText)
    {
        if (
            _workspace is null
            || !NativePaths.HasExtension(filePath, ".cs")
            || OwningProject(filePath) is not { } owner
            || _solution!.Projects.Any(project => NativePaths.AreEqual(project.FilePath, owner))
        )
        {
            return false;
        }

        _pendingTextEdits[filePath] = newText;
        _ = _owningLoads.GetOrAdd(owner, _ => Task.Run(() => AdoptNowAsync(owner, filePath)));
        return true;
    }

    /// <summary>
    /// The first <c>.csproj</c>, in name order, of the nearest directory at or above
    /// <paramref name="filePath"/>'s that holds one: an SDK project compiles every
    /// <c>.cs</c> file beneath it.
    /// </summary>
    private static string? OwningProject(string filePath)
    {
        var directory = NativePaths.DirectoryOf(filePath);
        while (directory.Length > 0)
        {
            if (ProjectsIn(directory).FirstOrDefault() is { } owner)
            {
                return owner;
            }
            var parent = NativePaths.DirectoryOf(directory);
            directory = NativePaths.AreEqual(parent, directory) ? "" : parent;
        }
        return null;
    }

    /// <summary>The <c>.csproj</c> files in <paramref name="directory"/>, in name order.</summary>
    private static IEnumerable<string> ProjectsIn(string directory)
    {
        try
        {
            return Directory.GetFiles(directory, "*.csproj").Order(NativePaths.Comparer);
        }
        catch (IOException)
        {
            return [];
        }
        catch (UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Load <paramref name="owner"/> beside the workspace, logging the outcome.</summary>
    private async Task AdoptNowAsync(string owner, string filePath)
    {
        try
        {
            await DotnetRestore
                .RestoreWhenMissingAsync(owner, CancellationToken.None)
                .ConfigureAwait(false);
            var infos = await RoslynProjectLoading
                .LoadBesideAsync(_workspace!, _solution!, owner, CancellationToken.None)
                .ConfigureAwait(false);
            await AddOwnerAsync(infos).ConfigureAwait(false);
            Log.Information(
                "C# loaded {Project}, which owns {File}, beside the workspace",
                owner,
                filePath
            );
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "C# could not load {Project}, which owns {File}", owner, filePath);
        }
        finally
        {
            _ = _owningLoads.TryRemove(owner, out _);
        }
    }

    /// <summary>The loaded projects into the live solution, then the edits held for them.</summary>
    private async Task AddOwnerAsync(IReadOnlyList<Microsoft.CodeAnalysis.ProjectInfo> infos)
    {
        await _solutionMutationLock.WaitAsync().ConfigureAwait(false);
        try
        {
            _solution = AddCrossLanguageMetadataReferences(
                RoslynProjectLoading.WithNew(_solution!, infos)
            );
            ReplayPendingTextEdits();
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }
}
