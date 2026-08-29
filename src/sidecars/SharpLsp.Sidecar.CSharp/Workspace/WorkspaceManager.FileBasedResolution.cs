using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Serilog;

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

    private void RemoveExistingProjectlessRoot(string rootPath)
    {
        var project = _adhocWorkspace?.CurrentSolution.Projects.FirstOrDefault(candidate =>
            candidate.FilePath is not null
            && string.Equals(
                NormalizeRootPath(candidate.FilePath),
                rootPath,
                StringComparison.OrdinalIgnoreCase
            )
        );
        if (project is null)
        {
            return;
        }

        var nextSolution = _adhocWorkspace!.CurrentSolution.RemoveProject(project.Id);
        if (!_adhocWorkspace.TryApplyChanges(nextSolution))
        {
            Log.Warning("Could not replace reopened projectless root {Root}", rootPath);
        }
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
        _ = ResolveAndUpgradeAsync(rootPath, projectId, closure, generation);
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
            ApplyAdhocChanges(nextSolution);
            _solution = nextSolution;
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    private void ApplyAdhocChanges(Solution nextSolution)
    {
        if (_adhocWorkspace is not null && !_adhocWorkspace.TryApplyChanges(nextSolution))
        {
            Log.Warning("Could not apply restored file-based package references");
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
        return Path.GetFullPath(path);
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
