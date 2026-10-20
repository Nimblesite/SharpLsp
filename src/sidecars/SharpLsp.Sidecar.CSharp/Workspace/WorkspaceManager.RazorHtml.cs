namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>Current HTML or null for an unlisted file; [RAZOR-ARCHITECTURE-HTML].</summary>
    internal Task<Outcome.Result<HtmlProjectionResult?, string>> GetRazorHtmlProjectionAsync(
        string filePath,
        CancellationToken ct
    )
    {
        return RunMarkupQueryAsync<HtmlProjectionResult?>(
            filePath,
            null,
            markup => Task.FromResult<HtmlProjectionResult?>(new() { Text = markup.HtmlText }),
            ct
        );
    }
}
