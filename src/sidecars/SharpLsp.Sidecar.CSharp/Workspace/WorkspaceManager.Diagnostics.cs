using Microsoft.CodeAnalysis;
using Serilog;
using DiagnosticsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Per-file diagnostics: compiler diagnostics, the tier-2 degradation notice and,
/// when the analyzer is on, dead code.
/// </summary>
internal sealed partial class WorkspaceManager
{
    private bool _deadCodeEnabled;
    private bool _monorepo;

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
    /// Get diagnostics for a file: FCS-style compiler diagnostics plus, when the
    /// dead-code analyzer is enabled, project-wide unused-symbol diagnostics
    /// (`SLSPC0101`, [ANALYZERS-UNUSED-PUBLIC]).
    /// </summary>
    public async Task<DiagnosticsResult> GetDiagnosticsAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        try
        {
            // The document snapshot and the tier-2 degradation notice MUST come from
            // the same instant, or a slow semantic-model computation can pair a
            // pre-restore compilation with a post-restore notice state and present
            // phantom package errors as final. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            var state = await CaptureDiagnosticsStateAsync(filePath, ct).ConfigureAwait(false);
            var diagnostics = await DiagnoseAsync(filePath, state, ct).ConfigureAwait(false);
            return new DiagnosticsResult.Ok<List<DiagnosticResult>, string>(diagnostics);
        }
        catch (Exception ex)
        {
            return DiagnosticsResult.Failure(ex.Message);
        }
    }

    /// <summary>
    /// The compiler diagnostics of the captured document, then its degradation notice,
    /// then its dead code; none when the file is not in the workspace or has no model.
    /// </summary>
    private async Task<List<DiagnosticResult>> DiagnoseAsync(
        string filePath,
        DiagnosticsState state,
        CancellationToken ct
    )
    {
        if (
            state.Document is not { } document
            || await document.GetSemanticModelAsync(ct).ConfigureAwait(false) is not { } model
        )
        {
            return [];
        }

        var diagnostics = MapDiagnostics(filePath, model, ct);
        AppendDegradation(filePath, state.Degradation, diagnostics);
        diagnostics.AddRange(await DeadCodeAsync(document, ct).ConfigureAwait(false));
        LogAnswer(filePath, diagnostics);
        return diagnostics;
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
        if (!_deadCodeEnabled || _solution is null)
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
