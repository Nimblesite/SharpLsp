using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.CSharp.Workspace;
using AllDiagnosticsResult = Outcome.Result<
    System.Collections.Generic.Dictionary<
        string,
        System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>
    >,
    string
>;
using DiagnosticMap = System.Collections.Generic.Dictionary<
    string,
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.DiagnosticResult>
>;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Tests collect real lazy source pulls; production has no bulk scan. [DIAG-IPC-WORKSPACE-PULL]</summary>
internal static class DiagnosticWorkspacePulls
{
    internal static Task<AllDiagnosticsResult> PullDiagnosticsAsync(
        this WorkspaceManager manager,
        CancellationToken ct = default
    )
    {
        return new PullSession(manager, ct).ReadAsync();
    }

    private sealed class PullSession(WorkspaceManager manager, CancellationToken ct)
    {
        private readonly DiagnosticMap _results = new(NativePaths.Comparer);

        internal async Task<AllDiagnosticsResult> ReadAsync()
        {
            ct.ThrowIfCancellationRequested();
            var documents = await manager.GetDocumentsAsync(ct).ConfigureAwait(false);
            return documents.IsError
                ? AllDiagnosticsResult.Failure(documents.Match(_ => string.Empty, error => error))
                : await ReadSourcesAsync(+documents).ConfigureAwait(false);
        }

        private async Task<AllDiagnosticsResult> ReadSourcesAsync(
            IEnumerable<DiagnosticDocument> documents
        )
        {
            foreach (var document in documents)
            {
                var error = await PullSourceAsync(document).ConfigureAwait(false);
                if (error is not null)
                {
                    return AllDiagnosticsResult.Failure(error);
                }
            }
            return new AllDiagnosticsResult.Ok<DiagnosticMap, string>(_results);
        }

        private async Task<string?> PullSourceAsync(DiagnosticDocument document)
        {
            ct.ThrowIfCancellationRequested();
            var result = await manager
                .GetDiagnosticsAsync(document.FilePath, ct)
                .ConfigureAwait(false);
            ct.ThrowIfCancellationRequested();
            if (result.IsError)
            {
                return result.Match(_ => string.Empty, error => error);
            }
            Append(document, +result);
            return null;
        }

        private void Append(DiagnosticDocument document, List<DiagnosticResult> diagnostics)
        {
            if (diagnostics.Count > 0)
            {
                _results[document.FilePath] = diagnostics;
            }
        }
    }
}
