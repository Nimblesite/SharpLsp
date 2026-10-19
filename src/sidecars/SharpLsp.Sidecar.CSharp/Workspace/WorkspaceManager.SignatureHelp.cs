using SignatureHelpQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.SignatureHelpResult?,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Signature help at a position: <see langword="null"/> when the caret is not
    /// inside a call's argument list, or the file is not in the workspace. A Razor position
    /// answers from its projection ([RAZOR-FEATURES-SIGNATURE-HELP]).
    /// Implements [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP] (GitHub #174).
    /// </summary>
    public Task<SignatureHelpQueryResult> GetSignatureHelpAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunPositionQueryAsync<SignatureHelpResult?>(
            filePath,
            (line, character),
            null,
            target =>
                SignatureHelpResolver.ResolveAsync(
                    target.Document,
                    target.Line,
                    target.Character,
                    ct
                ),
            ct
        );
    }
}
