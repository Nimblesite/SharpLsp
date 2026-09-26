using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Serilog;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Why a file-based root is still on tier-2 BCL references, and whether the
/// tier-1 restore that would replace it is still running.
/// <paramref name="IsPending"/> is the machine-readable form of that state —
/// the editor client polls on it, so it must never be inferred from message
/// text. Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
/// </summary>
internal sealed record ProjectlessDegradation(string Reason, bool IsPending);

/// <summary>
/// Manages immediate file-based fallback and generation-safe background MSBuild upgrades.
/// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>How long Dispose waits for cancelled restores to exit.</summary>
    private static readonly TimeSpan ResolutionDrainTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Background resolutions still running; the value is unused.</summary>
    private readonly ConcurrentDictionary<Task, byte> _packageResolutions = new();

    private async Task PrepareProjectlessRootAsync(string rootPath, CancellationToken ct)
    {
        rootPath = NormalizeRootPath(rootPath);
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _ = _packageResolutionGenerations.TryRemove(rootPath, out _);
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
            _ = _documentPackages.Remove(rootPath);
            _ = _documentDirectives.Remove(rootPath);
            RemoveExistingProjectlessRoot(rootPath);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    /// <summary>
    /// Drop the project a root already owns, so reopening it replaces rather than duplicates.
    /// </summary>
    /// <remarks>
    /// Scoped to THIS root by file path, and applied to <c>_solution</c> — the one
    /// authority. Removing from <c>_adhocWorkspace</c> instead left the removal
    /// invisible to everything that reads the solution, and made the workspace a
    /// second, silently diverging copy of the loaded set. Issue #294.
    /// </remarks>
    private void RemoveExistingProjectlessRoot(string rootPath)
    {
        var project = _solution?.Projects.FirstOrDefault(candidate =>
            candidate.FilePath is not null
            && NativePaths.Comparer.Equals(NormalizeRootPath(candidate.FilePath), rootPath)
        );
        if (project is null)
        {
            return;
        }

        _solution = _solution!.RemoveProject(project.Id);
    }

    /// <summary>
    /// A document snapshot paired with the tier-2 degradation notice from the SAME
    /// instant. Captured under <c>_solutionMutationLock</c> — the lock
    /// <see cref="ApplyPackageReferencesAsync"/> holds while it swaps the restored
    /// references and clears the notice — so a diagnostics answer can never pair a
    /// pre-upgrade compilation (package errors present) with a post-upgrade notice
    /// state (notice absent). The editor host stops republishing the moment an
    /// answer arrives without the pending notice, so one torn pair strands the
    /// tier-2 placeholder's phantom CS0246s on screen for the life of the document.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    /// </summary>
    private sealed record DiagnosticsState(Document? Document, ProjectlessDegradation? Degradation);

    private async Task<DiagnosticsState> CaptureDiagnosticsStateAsync(
        string filePath,
        CancellationToken ct
    )
    {
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            return new DiagnosticsState(document, DegradationFor(document, filePath));
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    private ProjectlessDegradation? DegradationFor(Document? document, string filePath)
    {
        return
            document is not null
            && _projectlessDegradations.TryGetValue(
                ProjectRootPath(document.Project, filePath),
                out var degradation
            )
            ? degradation
            : null;
    }

    private bool ProjectModelChanged(string rootPath, Closure closure)
    {
        return !_documentPackages.TryGetValue(rootPath, out var packages)
            || !closure.Packages.SequenceEqual(packages)
            || !_documentDirectives.TryGetValue(rootPath, out var directives)
            || !closure.Directives.SequenceEqual(directives);
    }

    private void StartPackageResolution(
        ProjectlessKind kind,
        string rootPath,
        ProjectId projectId,
        Closure closure
    )
    {
        rootPath = NormalizeRootPath(rootPath);
        var generation = Interlocked.Increment(ref _nextPackageResolutionGeneration);
        _packageResolutionGenerations[rootPath] = generation;
        _documentPackages[rootPath] = closure.Packages;
        _documentDirectives[rootPath] = closure.Directives;
        if (kind != ProjectlessKind.FileBasedApp)
        {
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
            return;
        }

        _projectlessDegradations[rootPath] = new ProjectlessDegradation(
            PendingEvaluationReason(closure.Packages),
            IsPending: true
        );
        Log.Debug(
            "File-based package resolution started for {Root} "
                + "(generation {Generation}, {PackageCount} package(s))",
            rootPath,
            generation,
            closure.Packages.Count
        );
        TrackPackageResolution(ResolveAndUpgradeAsync(rootPath, projectId, closure, generation));
    }

    private void TrackPackageResolution(Task resolution)
    {
        _packageResolutions[resolution] = 0;
        _ = resolution.ContinueWith(
            finished => _packageResolutions.TryRemove(finished, out _),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default
        );
    }

    /// <summary>
    /// Wait out every cancelled resolution. Its <c>dotnet restore</c> runs in the app's folder,
    /// and Windows refuses to delete a folder a live process stands in, so returning before
    /// the restore exits leaves the user's folder locked. Implements [SCRIPT-LIFECYCLE].
    /// </summary>
    private void DrainPackageResolutions()
    {
        var pending = _packageResolutions.Keys.ToArray();
        var drained = Task.WhenAll(pending)
            .ContinueWith(static _ => { }, TaskScheduler.Default)
            .Wait(ResolutionDrainTimeout);
        if (!drained)
        {
            Log.Warning(
                "Disposed with {Count} file-based package resolution(s) still running",
                pending.Length
            );
        }
    }

    private async Task ResolveAndUpgradeAsync(
        string rootPath,
        ProjectId projectId,
        Closure closure,
        long generation
    )
    {
        var ct = _packageResolutionCancellation.Token;
        try
        {
            var resolution = await FileBasedPackageResolver
                .ResolveAsync(closure, rootPath, generation, ct)
                .ConfigureAwait(false);
            if (resolution.IsError)
            {
                await TrackPackageFailureAsync(
                        rootPath,
                        generation,
                        !resolution ?? "Package restore failed.",
                        ct
                    )
                    .ConfigureAwait(false);
                return;
            }

            var project = resolution.Match(value => value, _ => null!);
            await ApplyPackageReferencesAsync(rootPath, projectId, project, generation, ct)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            Log.Debug("Cancelled file-based package resolution for {Root}", rootPath);
        }
        catch (Exception exception)
        {
            await TrackPackageFailureAsync(rootPath, generation, exception.Message, ct)
                .ConfigureAwait(false);
        }
    }

    private async Task ApplyPackageReferencesAsync(
        string rootPath,
        ProjectId projectId,
        ResolvedFileBasedProject resolved,
        long generation,
        CancellationToken ct
    )
    {
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!IsCurrentPackageResolution(rootPath, generation) || _solution is null)
            {
                return;
            }

            var project = _solution.GetProject(projectId);
            if (project is null)
            {
                return;
            }

            var nextProject = project
                .WithMetadataReferences(resolved.References)
                .WithCompilationOptions(resolved.CompilationOptions)
                .WithParseOptions(TierOneParseOptions(resolved.ParseOptions));
            var nextSolution = nextProject.Solution;
            Log.Information(
                "File-based restore settled for {Root} (generation {Generation}): "
                    + "{ReferenceCount} reference(s) applied",
                rootPath,
                generation,
                resolved.References.Count
            );
            _solution = nextSolution;
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    /// <summary>
    /// Record a terminal restore failure, but only while this generation is still
    /// current — checked UNDER the mutation lock. An unlocked check-then-write lets a
    /// stale generation's failure overwrite the pending notice a newer directive edit
    /// just installed, and a non-pending notice stops the host's republish loop while
    /// that newer restore is still in flight. Implements
    /// [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    /// </summary>
    private async Task TrackPackageFailureAsync(
        string rootPath,
        long generation,
        string reason,
        CancellationToken ct
    )
    {
        try
        {
            await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        }
        catch (Exception blocked)
            when (blocked is OperationCanceledException or ObjectDisposedException)
        {
            return; // A workspace reset or disposal is clearing the projectless state anyway.
        }

        try
        {
            RecordPackageFailure(rootPath, generation, reason);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    private void RecordPackageFailure(string rootPath, long generation, string reason)
    {
        if (!IsCurrentPackageResolution(rootPath, generation))
        {
            return;
        }

        _projectlessDegradations[rootPath] = new ProjectlessDegradation(reason, IsPending: false);
        Log.Warning("File-based package restore degraded to BCL references: {Reason}", reason);
    }

    private bool IsCurrentPackageResolution(string rootPath, long generation)
    {
        return _packageResolutionGenerations.TryGetValue(rootPath, out var current)
            && current == generation;
    }

    private static ImmutableArray<PortableExecutableReference> BasicReferences()
    {
        return Basic.Reference.Assemblies.Net100.References.All;
    }

    private static string ProjectRootPath(Project project, string fallback)
    {
        return NormalizeRootPath(project.FilePath ?? fallback);
    }

    private static string NormalizeRootPath(string path)
    {
        return NativePaths.NormalizeFullPath(path);
    }

    private static string DescribePackages(IEnumerable<PackageRef> packages)
    {
        return string.Join(
            ", ",
            packages.Select(package =>
                string.IsNullOrEmpty(package.Version)
                    ? package.Name
                    : $"{package.Name}@{package.Version}"
            )
        );
    }

    private static string PendingEvaluationReason(IReadOnlyList<PackageRef> packages)
    {
        return packages.Count == 0
            ? "MSBuild evaluation is pending."
            : $"Restore pending for {DescribePackages(packages)}.";
    }

    private static CSharpParseOptions TierOneParseOptions(CSharpParseOptions options)
    {
        return options
            .WithKind(SourceCodeKind.Regular)
            .WithFeatures([new KeyValuePair<string, string>("FileBasedProgram", "true")]);
    }

    private async Task ResetProjectlessStateAsync(CancellationToken ct)
    {
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _packageResolutionGenerations.Clear();
            _documentPackages.Clear();
            _documentDirectives.Clear();
            _projectlessDegradations.Clear();
            await _packageResolutionCancellation.CancelAsync().ConfigureAwait(false);
            _packageResolutionCancellation.Dispose();
            _packageResolutionCancellation = new CancellationTokenSource();
            _adhocWorkspace?.Dispose();
            _adhocWorkspace = null;
            _isProjectlessDirectory = false;
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }
}
