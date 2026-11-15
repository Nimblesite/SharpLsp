using ResolveResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

// The fix-all half of the code-action surface, split from WorkspaceManager so
// neither file grows past the size budget. Implements [FIXALL-SCOPES].
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Resolve a fix-all to one workspace edit over <paramref name="scope"/> —
    /// the document, its project, or every loaded project. Implements
    /// [FIXALL-SCOPES] for C# (GitHub #577).
    /// </summary>
    public async Task<ResolveResult> FixAllAsync(
        string filePath,
        string fixKey,
        string scope,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            return document is null
                ? ResolveResult.Failure(
                    $"the file is not part of the loaded C# solution, so '{fixKey}' cannot run at {scope} scope"
                )
                : await _codeActionResolver
                    .FixAllAsync(document, fixKey, scope, ct)
                    .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return ResolveResult.Failure(ex.Message);
        }
    }
}
