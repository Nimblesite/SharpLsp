using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    /// <summary>Current HTML or null for an unlisted file; [RAZOR-ARCHITECTURE-HTML].</summary>
    internal Task<Outcome.Result<HtmlProjectionResult?, string>> GetRazorHtmlProjectionAsync(
        string filePath,
        CancellationToken ct,
        (int Line, int Character)? position = null
    )
    {
        return RunMarkupQueryAsync<HtmlProjectionResult?>(
            filePath,
            null,
            async markup =>
                position is { } at
                && !MarkupNameAt(markup, at)
                && await ResolveCompletionTargetAsync(filePath, at, ct).ConfigureAwait(false)
                    is not null
                    ? null
                    : new HtmlProjectionResult { Text = markup.HtmlText },
            ct
        );
    }

    /// <summary>Component names and parameters can also have C# mappings; they remain markup.</summary>
    private static bool MarkupNameAt(RazorMarkup markup, (int Line, int Character) at)
    {
        var offset = DocumentText.TryOffset(markup.Text, new LinePosition(at.Line, at.Character));
        return offset is { } found
            && (markup.TagNamedAt(found) is not null || markup.AttributeNamedAt(found) is not null);
    }
}
