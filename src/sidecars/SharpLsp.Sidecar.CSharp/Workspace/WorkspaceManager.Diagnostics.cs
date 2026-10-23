using Microsoft.CodeAnalysis;
using Serilog;
using SharpLsp.Sidecar.Common;
using DiagnosticsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Per-file diagnostics: compiler diagnostics, the tier-2 degradation notice, the
/// project analyzer diagnostics (when the analyzer gate is on) and the dead-code
/// analyzer (when both gates are on).
/// </summary>
internal sealed partial class WorkspaceManager
{
    private bool _deadCodeEnabled;
    private bool _monorepo;

    /// <summary>
    /// Whether project analyzers — the SDK/NuGet analyzers the project references and
    /// the IDE style analyzers — report beside the compiler diagnostics. Toggled by
    /// the host's <c>diagnostics/configure</c> push; compiler diagnostics are never
    /// suppressed by it ([DIAG-CATEGORIES-ANALYZER]).
    /// </summary>
    private bool _analyzersEnabled = true;

    /// <summary>
    /// Configure the analyzer gate from the host's <c>diagnostics/configure</c> push.
    /// The flag persists across workspace re-opens, like the analyzer flags do.
    /// </summary>
    public void ConfigureDiagnostics(bool analyzersEnabled)
    {
        _analyzersEnabled = analyzersEnabled;
    }

    /// <summary>
    /// Configure the static analyzers from the host's <c>analyzers/configure</c>
    /// push ([ANALYZERS-CONFIG-IMPL]). Flags persist across workspace re-opens.
    /// Defaults are off so direct test construction never gets dead-code diagnostics
    /// unless explicitly enabled; the host always configures in production.
    /// </summary>
    public void ConfigureAnalyzers(bool deadCode, bool monorepo)
    {
        _deadCodeEnabled = deadCode;
        _monorepo = monorepo;
    }

    /// <summary>
    /// Get diagnostics for a file: compiler diagnostics, then the degradation notice,
    /// then — when the analyzer gate is on — the project analyzers and the project-wide
    /// unused-symbol dead-code analyzer (`SLSPC0101`, [ANALYZERS-UNUSED-PUBLIC]).
    /// </summary>
    public Task<DiagnosticsResult> GetDiagnosticsAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        return QueryDiagnosticsAsync(filePath, settled: true, ct);
    }

    /// <summary>
    /// Report the current restore state promptly for reactive editors. A pending
    /// restore reports its notice without speculative compiler errors.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK] and [DIAG-PUSH-GATE].
    /// </summary>
    public Task<DiagnosticsResult> GetCurrentDiagnosticsAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        return QueryDiagnosticsAsync(filePath, settled: false, ct);
    }

    private async Task<DiagnosticsResult> QueryDiagnosticsAsync(
        string filePath,
        bool settled,
        CancellationToken ct
    )
    {
        try
        {
            return await DiagnoseSnapshotAsync(filePath, settled, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return DiagnosticsResult.Failure(ex.Message);
        }
    }

    /// <summary>The source and restore notice always belong to one atomic snapshot.</summary>
    private async Task<DiagnosticsResult> DiagnoseSnapshotAsync(
        string filePath,
        bool settled,
        CancellationToken ct
    )
    {
        return NativePaths.IsRazor(filePath)
            ? SuccessfulDiagnostics(await DiagnoseRazorAsync(filePath, ct).ConfigureAwait(false))
            : await DiagnoseAsync(
                    filePath,
                    await (
                        settled
                            ? CaptureSettledDiagnosticsStateAsync(filePath, ct)
                            : CaptureDiagnosticsStateAsync(filePath, ct)
                    ).ConfigureAwait(false),
                    ct
                )
                .ConfigureAwait(false);
    }

    /// <summary>
    /// The compiler diagnostics of the captured document, then its degradation notice,
    /// then its dead code. [DIAG-TRUTH-GUARANTEES]: unavailable inputs remain a failure.
    /// </summary>
    private async Task<DiagnosticsResult> DiagnoseAsync(
        string filePath,
        DiagnosticsState state,
        CancellationToken ct
    )
    {
        return state.Degradation is { IsPending: true } pending
                ? SuccessfulDiagnostics([DegradationDiagnostic(filePath, pending)])
            : state.Document is { } document
                ? await DiagnoseModelAsync(filePath, document, state.Degradation, ct)
                    .ConfigureAwait(false)
            : DiagnosticsResult.Failure("The requested compiler document is not loaded.");
    }

    /// <summary>Only completed compiler analysis produces successful diagnostic truth.</summary>
    private static DiagnosticsResult SuccessfulDiagnostics(List<DiagnosticResult> diagnostics)
    {
        return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(diagnostics);
    }

    /// <summary>Compiler and analyzer truth from the captured, resolved document.</summary>
    private async Task<DiagnosticsResult> DiagnoseModelAsync(
        string filePath,
        Document document,
        ProjectlessDegradation? degradation,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model is null)
        {
            return DiagnosticsResult.Failure(
                "The requested compiler semantic model is unavailable."
            );
        }
        var diagnostics = MapDiagnostics(filePath, model, ct);
        AppendDegradation(filePath, degradation, diagnostics);
        diagnostics.AddRange(
            await DocumentAnalyzerDiagnosticsAsync(document, model, filePath, ct)
                .ConfigureAwait(false)
        );
        diagnostics.AddRange(await DeadCodeAsync(document, ct).ConfigureAwait(false));
        LogAnswer(filePath, diagnostics);
        return SuccessfulDiagnostics(diagnostics);
    }

    /// <summary>
    /// The document's project-analyzer diagnostics — SDK/NuGet and IDE style
    /// analyzers under the effective .editorconfig — when the analyzer gate is on.
    /// Runs beside the compiler diagnostics, never instead of them.
    /// </summary>
    private async Task<List<DiagnosticResult>> DocumentAnalyzerDiagnosticsAsync(
        Document document,
        SemanticModel model,
        string filePath,
        CancellationToken ct
    )
    {
        if (!_analyzersEnabled)
        {
            return [];
        }

        var analyzers = AnalyzerDiagnosticResolver.DiscoverDocumentAnalyzers(document.Project);
        if (analyzers.IsEmpty)
        {
            return [];
        }

        var found = await AnalyzerDiagnosticResolver
            .ResolveDocumentAsync(document, model, analyzers, ct)
            .ConfigureAwait(false);
        return MapAnalyzerDiagnostics(filePath, found);
    }

    /// <summary>
    /// Project-wide unused-symbol diagnostics for <paramref name="document"/>; none while
    /// the dead-code analyzer is off or no solution is loaded ([ANALYZERS-UNUSED-PUBLIC]).
    /// </summary>
    private async Task<List<DiagnosticResult>> DeadCodeAsync(
        Document document,
        CancellationToken ct
    )
    {
        if (!_deadCodeEnabled || !_analyzersEnabled || _solution is null)
        {
            return [];
        }

        var scope = await SearchScope
            .OfAsync(document, _activeFrameworks, ct)
            .ConfigureAwait(false);
        return await DeadCodeAnalyzer
            .AnalyzeAsync(document, scope, _monorepo, ct)
            .ConfigureAwait(false);
    }

    private static void LogAnswer(string filePath, List<DiagnosticResult> diagnostics)
    {
        Log.Debug(
            "Diagnostics answer for {File}: [{Codes}]",
            filePath,
            string.Join(",", diagnostics.Select(diagnostic => diagnostic.Code))
        );
    }
}
