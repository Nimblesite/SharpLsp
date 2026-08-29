using SharpLsp.Sidecar.CSharp.Workspace;

// RS1035: these tests deliberately touch the real filesystem — the repo mandates testing
// against real files, not mocks.
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Shared scaffolding for the project-less (file-based app / script) suites: a throwaway
/// directory on the real filesystem, plus the two boundaries every one of those tests drives —
/// <c>OpenAsync</c> and <c>GetDiagnosticsAsync</c>.
/// Supports [SCRIPT-FILEBASED], [SCRIPT-CSX], [SCRIPT-CLOSURE], [SCRIPT-DEGRADE].
/// </summary>
internal sealed class ProjectlessWorkspaceFixture : IDisposable
{
    /// <summary>The tier-2 "degraded to BCL-only references" notice code.</summary>
    public const string DegradationCode = "SLSPC0001";

    /// <summary>The tier-2 "restore has not finished yet" notice code.</summary>
    public const string RestorePendingCode = "SLSPC0002";

    public ProjectlessWorkspaceFixture(string prefix)
    {
        Root = Path.Combine(Path.GetTempPath(), $"sharplsp-{prefix}-{Guid.NewGuid():N}");
        _ = Directory.CreateDirectory(Root);
    }

    /// <summary>The throwaway directory every fixture file is written under.</summary>
    public string Root { get; }

    public void Dispose()
    {
        if (Directory.Exists(Root))
        {
            Directory.Delete(Root, true);
        }
    }

    /// <summary>Write <paramref name="text"/> to <paramref name="relativePath"/> under the root.</summary>
    public string Write(string relativePath, string text)
    {
        var path = Path.Combine(Root, relativePath);
        _ = Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        return path;
    }

    // OpenAsync is [Obsolete] as a design placeholder, not because it is unsafe. The tests must
    // exercise the real entry point rather than a private shim, so the warning is suppressed at
    // this single call site.
#pragma warning disable CS0618
    public static Task<Outcome.Result<Outcome.Unit, string>> OpenAsync(
        WorkspaceManager manager,
        string path
    )
    {
        return manager.OpenAsync(path);
    }
#pragma warning restore CS0618

    /// <summary>Every diagnostic the sidecar publishes for <paramref name="path"/>.</summary>
    public static async Task<List<DiagnosticResult>> DiagnosticsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var result = await manager.GetDiagnosticsAsync(path).ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return result.Match(value => value, _ => []);
    }

    /// <summary>The <c>SLSPC0001</c> tier-2 degradation notice for a path, if one is published.</summary>
    public static DiagnosticResult? Degradation(IEnumerable<DiagnosticResult> diagnostics)
    {
        return diagnostics.FirstOrDefault(diagnostic =>
            string.Equals(diagnostic.Code, DegradationCode, StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// Block until the background MSBuild upgrade for a file-based app has settled, and return
    /// the diagnostics at that point. A file-based app loads on tier 2 (BCL references) with a
    /// "restore pending" notice and is upgraded to tier 1 out of band, so any assertion about
    /// packages taken before the upgrade lands measures the placeholder, not the outcome.
    /// Settled means the pending notice (<c>SLSPC0002</c>) is gone: the root either upgraded to
    /// tier 1 or published the terminal <c>SLSPC0001</c> failure notice.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    /// </summary>
    public static async Task<List<DiagnosticResult>> SettledDiagnosticsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromMinutes(2);
        while (true)
        {
            var diagnostics = await DiagnosticsAsync(manager, path).ConfigureAwait(false);
            var pending = diagnostics.FirstOrDefault(diagnostic =>
                string.Equals(diagnostic.Code, RestorePendingCode, StringComparison.Ordinal)
            );
            if (pending is null)
            {
                return diagnostics;
            }

            Assert.True(
                DateTime.UtcNow < deadline,
                $"file-based package resolution never settled: {pending.Message}"
            );
            await Task.Delay(100).ConfigureAwait(false);
        }
    }

    /// <summary>Only the error-severity diagnostics for <paramref name="path"/>.</summary>
    public static async Task<List<DiagnosticResult>> ErrorsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var diagnostics = await DiagnosticsAsync(manager, path).ConfigureAwait(false);
        return
        [
            .. diagnostics.Where(diagnostic =>
                string.Equals(diagnostic.Severity, "error", StringComparison.OrdinalIgnoreCase)
            ),
        ];
    }
}
