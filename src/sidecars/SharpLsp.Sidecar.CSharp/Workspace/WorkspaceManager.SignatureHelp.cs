using SignatureHelpQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.SignatureHelpResult?,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Signature help at a position: <see langword="null"/> when the caret is not
    /// inside a call's argument list, or the file is not in the workspace.
    /// Implements [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP] (GitHub #174).
    /// </summary>
    public Task<SignatureHelpQueryResult> GetSignatureHelpAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<SignatureHelpResult?>(
            filePath,
            null,
            document => SignatureHelpResolver.ResolveAsync(document, line, character, ct),
            ct
        );
    }
}
