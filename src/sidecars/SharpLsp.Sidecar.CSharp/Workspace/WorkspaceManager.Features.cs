using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using CodeLensesResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CodeLensResult>,
    string
>;
using FormattingResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.TextEditResult>,
    string
>;
using InlayHintsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.InlayHintResult>,
    string
>;
using SemanticTokensResultType = Outcome.Result<
    SharpLsp.Sidecar.CSharp.SemanticTokensResult,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Formatting, semantic tokens, and inlay hints.
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Get code lenses for a document, or, for a Razor file, those of the members its C#
    /// fragments declare, each on its Razor declaration. [RAZOR-FEATURES-CODE-LENS]
    /// </summary>
    public Task<CodeLensesResult> GetCodeLensesAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        return NativePaths.IsRazor(filePath)
            ? GetRazorCodeLensesAsync(filePath, ct)
            : RunScopedQueryAsync<List<CodeLensResult>>(
                filePath,
                [],
                (document, scope) => CodeLensResolver.GetLensesAsync(document, scope, ct),
                ct
            );
    }

    /// <summary>Format an entire document. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public Task<FormattingResult> FormatDocumentAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<List<TextEditResult>>(
            filePath,
            [],
            document => FormattingResolver.FormatDocumentAsync(document, ct),
            ct
        );
    }

    /// <summary>Format a range within a document. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public Task<FormattingResult> FormatRangeAsync(
        string filePath,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<List<TextEditResult>>(
            filePath,
            [],
            document =>
                FormattingResolver.FormatRangeAsync(
                    document,
                    startLine,
                    startCharacter,
                    endLine,
                    endCharacter,
                    ct
                ),
            ct
        );
    }

    /// <summary>Format after typing a trigger character. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public Task<FormattingResult> FormatOnTypeAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<List<TextEditResult>>(
            filePath,
            [],
            document => FormattingResolver.FormatOnTypeAsync(document, line, character, ct),
            ct
        );
    }

    /// <summary>Get semantic tokens for a full document.</summary>
    public Task<SemanticTokensResultType> GetSemanticTokensFullAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        return NativePaths.IsRazor(filePath)
            ? GetRazorSemanticTokensAsync(filePath, null, ct)
            : RunDocumentQueryAsync(
                filePath,
                new SemanticTokensResult(),
                async document => new SemanticTokensResult
                {
                    Data = await SemanticTokensResolver
                        .GetFullAsync(document, ct)
                        .ConfigureAwait(false),
                },
                ct
            );
    }

    /// <summary>Get semantic tokens for a range.</summary>
    public Task<SemanticTokensResultType> GetSemanticTokensRangeAsync(
        string filePath,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct = default
    )
    {
        if (NativePaths.IsRazor(filePath))
        {
            var range = new LinePositionSpan(
                new LinePosition(startLine, startCharacter),
                new LinePosition(endLine, endCharacter)
            );
            return GetRazorSemanticTokensAsync(filePath, range, ct);
        }

        return RunDocumentQueryAsync(
            filePath,
            new SemanticTokensResult(),
            async document => new SemanticTokensResult
            {
                Data = await SemanticTokensResolver
                    .GetRangeAsync(document, startLine, startCharacter, endLine, endCharacter, ct)
                    .ConfigureAwait(false),
            },
            ct
        );
    }

    /// <summary>
    /// Get inlay hints for a range, or, for a Razor file, those of the C# its lines hold, each
    /// placed back in the file. [RAZOR-FEATURES-INLAY-HINTS]
    /// </summary>
    public Task<InlayHintsResult> GetInlayHintsAsync(
        string filePath,
        int startLine,
        int endLine,
        CancellationToken ct = default
    )
    {
        return NativePaths.IsRazor(filePath)
            ? GetRazorInlayHintsAsync(filePath, startLine, endLine, ct)
            : RunDocumentQueryAsync<List<InlayHintResult>>(
                filePath,
                [],
                document => InlayHintResolver.GetHintsAsync(document, startLine, endLine, ct),
                ct
            );
    }
}
