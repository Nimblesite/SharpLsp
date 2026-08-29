using System.Collections.Immutable;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Debugging;

/// <summary>
/// One Roslyn Edit-and-Continue baseline for one live debug session.
/// Implements [DEBUG-FEATURES-HOT-RELOAD] with a two-phase protocol: `update`
/// emits deltas and holds them pending, and the client answers `commit` once
/// the debuggee confirmed them or `discard` when it did not — Roslyn's
/// baseline and the running process can never silently diverge.
/// </summary>
internal sealed class HotReloadSession : IAsyncDisposable
{
    private readonly MSBuildWorkspace _workspace;
    private readonly HotReloadEncService _enc;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private Solution _solution;
    private Solution? _pending;
    private bool _ended;

    public Guid Id { get; } = Guid.NewGuid();
    public string AssemblyName { get; }

    private HotReloadSession(MSBuildWorkspace workspace, Project baseline, HotReloadEncService enc)
    {
        _workspace = workspace;
        _solution = baseline.Solution;
        AssemblyName = baseline.AssemblyName ?? baseline.Name;
        _enc = enc;
    }

    public static async Task<HotReloadSession> CreateAsync(
        string projectPath,
        ImmutableArray<string> capabilities,
        CancellationToken ct
    )
    {
        var workspace = MSBuildWorkspace.Create(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["Configuration"] = "Debug",
            }
        );
        try
        {
            var baseline = await LoadBaselineProjectAsync(workspace, projectPath, ct)
                .ConfigureAwait(false);
            var enc = await HotReloadEncService
                .StartAsync(workspace.Services, baseline.Solution, capabilities, ct)
                .ConfigureAwait(false);
            Log.Information(
                "Hot reload session started for {Project} with {Capabilities}",
                projectPath,
                capabilities
            );
            return new HotReloadSession(workspace, baseline, enc);
        }
        catch
        {
            workspace.Dispose();
            throw;
        }
    }

    /// <summary>Open the built project and point Roslyn at its output assembly.</summary>
    private static async Task<Project> LoadBaselineProjectAsync(
        MSBuildWorkspace workspace,
        string projectPath,
        CancellationToken ct
    )
    {
        var project = await workspace
            .OpenProjectAsync(CanonicalPath(projectPath), cancellationToken: ct)
            .ConfigureAwait(false);
        var solution = project.Solution;
        foreach (var loadedProject in project.Solution.Projects)
        {
            if (loadedProject.OutputFilePath is { } assemblyPath)
            {
                solution = solution.WithProjectCompilationOutputInfo(
                    loadedProject.Id,
                    loadedProject.CompilationOutputInfo.WithAssemblyPath(assemblyPath)
                );
            }
        }

        return solution.GetProject(project.Id)!;
    }

    /// <summary>Emit deltas for one saved batch; they stay pending until commit or discard.</summary>
    public async Task<HotReloadResponse> UpdateAsync(
        IReadOnlyList<HotReloadDocument> documents,
        CancellationToken ct
    )
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_ended, this);
            DiscardStalePending();
            var candidate = BuildCandidate(documents);
            if (
                await ChangedSignatureAsync(candidate, documents, ct).ConfigureAwait(false) is
                { } changedMethod
            )
            {
                Log.Warning("Hot reload refused: signature of {Method} changed", changedMethod);
                return Response("restartRequired", [], [SignatureChangeReason(changedMethod)]);
            }
            var emitted = await _enc.EmitAsync(candidate, ct).ConfigureAwait(false);
            return Verdict(emitted, candidate);
        }
        finally
        {
            _ = _gate.Release();
        }
    }

    /// <summary>A client that never confirmed its last emit forfeits it.</summary>
    private void DiscardStalePending()
    {
        if (_pending is null)
        {
            return;
        }

        Log.Warning("Hot reload discarding an uncommitted update the client never confirmed");
        _enc.Discard();
        _pending = null;
    }

    private Solution BuildCandidate(IReadOnlyList<HotReloadDocument> documents)
    {
        var candidate = _solution;
        foreach (var document in documents)
        {
            var target = FindDocument(candidate, document.FilePath);
            candidate = candidate.WithDocumentText(
                target.Id,
                SourceText.From(document.NewText, Encoding.UTF8)
            );
        }

        return candidate;
    }

    private async Task<string?> ChangedSignatureAsync(
        Solution candidate,
        IReadOnlyList<HotReloadDocument> documents,
        CancellationToken ct
    )
    {
        foreach (var document in documents)
        {
            var baseline = FindDocument(_solution, document.FilePath);
            var changed = await HotReloadSignatureGuard
                .ChangedMethodSignatureAsync(baseline, candidate.GetDocument(baseline.Id)!, ct)
                .ConfigureAwait(false);
            if (changed is not null)
            {
                return changed;
            }
        }

        return null;
    }

    /// <summary>
    /// Judge one emit. Errors mean nothing can be applied: rude edits (ENC0xxx)
    /// require a restart, while compiler errors and Roslyn's operational
    /// ENC1xxx diagnostics resolve on a later save. A ready emit with deltas
    /// stays pending for the client's commit or discard; a ready emit with
    /// nothing to deliver commits immediately.
    /// </summary>
    private HotReloadResponse Verdict(EncEmitResult emitted, Solution candidate)
    {
        var errors = emitted
            .Diagnostics.Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .ToList();
        var rendered = emitted.Diagnostics.Select(HotReloadEncService.Render).ToList();
        if (errors.Count > 0)
        {
            var status = errors.Any(IsRudeEdit) ? "restartRequired" : "notCompilable";
            Log.Warning("Hot reload {Status}: {Diagnostics}", status, rendered);
            return Response(status, [], [.. errors.Select(HotReloadEncService.Render)]);
        }
        if (!emitted.Ready)
        {
            Log.Warning("Hot reload emit was not ready and named no diagnostic");
            return Response("notCompilable", [], ["The change could not be applied; save again."]);
        }

        return Emitted(emitted, candidate, rendered);
    }

    /// <summary>A ready emit: hold deltas pending, or self-commit an empty one.</summary>
    private HotReloadResponse Emitted(
        EncEmitResult emitted,
        Solution candidate,
        List<string> warnings
    )
    {
        if (emitted.Updates.Count == 0)
        {
            _enc.Commit();
            _solution = candidate;
            Log.Information("Hot reload emit had no runtime effect; committed");
            return Response("applied", [], warnings);
        }

        _pending = candidate;
        Log.Information(
            "Hot reload emitted {Count} delta(s), awaiting commit",
            emitted.Updates.Count
        );
        return Response("applied", emitted.Updates, warnings);
    }

    /// <summary>The debuggee confirmed the pending deltas.</summary>
    public async Task<HotReloadResponse> CommitAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_ended, this);
            var pending =
                _pending
                ?? throw new InvalidOperationException("Hot reload has no update to commit.");
            _enc.Commit();
            _solution = pending;
            _pending = null;
            Log.Information("Hot reload update committed");
            return Response("committed", [], []);
        }
        finally
        {
            _ = _gate.Release();
        }
    }

    /// <summary>The debuggee never applied the pending deltas; idempotent.</summary>
    public async Task<HotReloadResponse> DiscardAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_ended, this);
            if (_pending is not null)
            {
                _enc.Discard();
                _pending = null;
                Log.Information("Hot reload update discarded");
            }

            return Response("discarded", [], []);
        }
        finally
        {
            _ = _gate.Release();
        }
    }

    private static bool IsRudeEdit(Diagnostic diagnostic)
    {
        return diagnostic.Id.StartsWith("ENC0", StringComparison.Ordinal);
    }

    /// <summary>
    /// The message Roslyn's own ENC0110 rude edit carries, produced here because
    /// newer runtimes can APPLY a signature change by adding a new method — and
    /// [DEBUG-FEATURES-HOT-RELOAD] pins "Change method signature" to a restart.
    /// </summary>
    private static string SignatureChangeReason(string methodName)
    {
        return $"ENC0110: Changing the signature of method '{methodName}' requires restarting the application.";
    }

    public HotReloadResponse Response(
        string status,
        List<HotReloadDelta> updates,
        List<string> diagnostics
    )
    {
        return new HotReloadResponse
        {
            Status = status,
            SessionId = Id.ToString("D"),
            AssemblyName = AssemblyName,
            Updates = updates,
            Diagnostics = diagnostics,
        };
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            EndOnce();
        }
        finally
        {
            _ended = true;
            _workspace.Dispose();
            _ = _gate.Release();
            _gate.Dispose();
        }
    }

    private void EndOnce()
    {
        if (_ended)
        {
            return;
        }

        DiscardStalePending();
        _enc.End();
        Log.Information("Hot reload session {Id} ended", Id);
    }

    private static Document FindDocument(Solution solution, string filePath)
    {
        var fullPath = CanonicalPath(filePath);
        return solution
                .Projects.SelectMany(project => project.Documents)
                .FirstOrDefault(document => PathsEqual(document.FilePath, fullPath))
            ?? throw new InvalidOperationException($"Hot reload document not found: {filePath}");
    }

    private static bool PathsEqual(string? left, string right)
    {
        return left is not null
            && string.Equals(
                CanonicalPath(left),
                right,
                OperatingSystem.IsWindows()
                    ? StringComparison.OrdinalIgnoreCase
                    : StringComparison.Ordinal
            );
    }

    private static string CanonicalPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        return OperatingSystem.IsWindows() ? fullPath : ResolveLinks(fullPath);
    }

    /// <summary>Resolve each symlinked segment, as editors hand out both spellings.</summary>
    private static string ResolveLinks(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)!;
        var current = root;
        foreach (
            var segment in fullPath[root.Length..]
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
        )
        {
            current = Path.Combine(current, segment);
            FileSystemInfo entry = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (entry.ResolveLinkTarget(returnFinalTarget: true) is { } target)
            {
                current = target.FullName;
            }
        }

        return current;
    }
}
