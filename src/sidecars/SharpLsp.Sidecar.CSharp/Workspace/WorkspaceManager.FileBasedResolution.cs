using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

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

        _projectlessDegradations[rootPath] = PendingEvaluationReason(closure.Packages);
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
                .ResolveAsync(closure, rootPath, ct)
                .ConfigureAwait(false);
            if (resolution.IsError)
            {
                TrackPackageFailure(rootPath, generation, !resolution ?? "Package restore failed.");
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
            TrackPackageFailure(rootPath, generation, exception.Message);
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

    private void TrackPackageFailure(string rootPath, long generation, string reason)
    {
        if (!IsCurrentPackageResolution(rootPath, generation))
        {
            return;
        }

        _projectlessDegradations[rootPath] = reason;
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
