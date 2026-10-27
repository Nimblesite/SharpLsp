using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using DiagnosticsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>Project compiler truth on demand, without eager workspace scans or a result cache.</summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>Global and generated-source failures remain visible at their owning project.</summary>
    public async Task<DiagnosticsResult> GetProjectDiagnosticsAsync(
        string projectPath,
        CancellationToken ct = default
    )
    {
        try
        {
            var project = _solution?.Projects.FirstOrDefault(project =>
                project.FilePath is { } file && NativePaths.AreEqual(file, projectPath)
            );
            var compilation = project is null
                ? null
                : await project.GetCompilationAsync(ct).ConfigureAwait(false);
            return compilation is null || project is null
                ? DiagnosticsResult.Failure("The requested compiler project is not loaded.")
                : new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(
                    MapProjectDiagnostics(project, compilation, projectPath, ct)
                );
        }
        catch (Exception ex)
        {
            return DiagnosticsResult.Failure(ex.Message);
        }
    }

    // Implements [DIAG-CATEGORIES-COMPILER]: source diagnostics keep their existing owner.
    private static List<DiagnosticResult> MapProjectDiagnostics(
        Project project,
        Compilation compilation,
        string projectPath,
        CancellationToken ct
    )
    {
        var sources = DiagnosticPaths(project, projectsOnly: false)
            .Where(IsUserDiagnosticPath)
            .ToHashSet(NativePaths.Comparer);
        var location = new FileLinePositionSpan(
            projectPath,
            new LinePosition(0, 0),
            new LinePosition(0, 0)
        );
        // A reference Roslyn refuses to load (e.g. one built against a newer Roslyn)
        // is reported like the SDK build does — CS9057/CS8032 — never dropped
        // into a silent clean answer ([DIAG-CATEGORIES-ANALYZER]).
        var loadFailures = AnalyzerLoadMonitor
            .ProjectFailures(project)
            .Select(failure => failure.ToDiagnostic(projectPath));
        return
        [
            .. loadFailures,
            .. compilation
                .GetDiagnostics(ct)
                .Where(diagnostic =>
                    !diagnostic.IsSuppressed
                    // Generated-source edit hints have no actionable project location.
                    && diagnostic.Severity != DiagnosticSeverity.Hidden
                    && (
                        !diagnostic.Location.IsInSource
                        || !sources.Contains(diagnostic.Location.GetMappedLineSpan().Path)
                    )
                )
                .Select(diagnostic => MapOneDiagnostic(projectPath, diagnostic, location)),
        ];
    }
}
