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
    /// <summary>Get code lenses for a document.</summary>
    public async Task<CodeLensesResult> GetCodeLensesAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return new CodeLensesResult.Ok<List<CodeLensResult>, string>([]);
            }

            var lenses = await CodeLensResolver
                .GetLensesAsync(document, _solution, ct)
                .ConfigureAwait(false);
            return new CodeLensesResult.Ok<List<CodeLensResult>, string>(lenses);
        }
        catch (Exception ex)
        {
            return CodeLensesResult.Failure(ex.Message);
        }
    }

    /// <summary>Format an entire document. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public async Task<FormattingResult> FormatDocumentAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new FormattingResult.Ok<List<TextEditResult>, string>([]);
            }

            var edits = await FormattingResolver
                .FormatDocumentAsync(document, ct)
                .ConfigureAwait(false);
            return new FormattingResult.Ok<List<TextEditResult>, string>(edits);
        }
        catch (Exception ex)
        {
            return FormattingResult.Failure(ex.Message);
        }
    }

    /// <summary>Format a range within a document. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public async Task<FormattingResult> FormatRangeAsync(
        string filePath,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new FormattingResult.Ok<List<TextEditResult>, string>([]);
            }

            var edits = await FormattingResolver
                .FormatRangeAsync(document, startLine, startCharacter, endLine, endCharacter, ct)
                .ConfigureAwait(false);
            return new FormattingResult.Ok<List<TextEditResult>, string>(edits);
        }
        catch (Exception ex)
        {
            return FormattingResult.Failure(ex.Message);
        }
    }

    /// <summary>Format after typing a trigger character. SEQUESTERED — not called by the LSP server.</summary>
    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]
    public async Task<FormattingResult> FormatOnTypeAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new FormattingResult.Ok<List<TextEditResult>, string>([]);
            }

            var edits = await FormattingResolver
                .FormatOnTypeAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new FormattingResult.Ok<List<TextEditResult>, string>(edits);
        }
        catch (Exception ex)
        {
            return FormattingResult.Failure(ex.Message);
        }
    }

    /// <summary>Get semantic tokens for a full document.</summary>
    public async Task<SemanticTokensResultType> GetSemanticTokensFullAsync(
        string filePath,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new SemanticTokensResultType.Ok<SemanticTokensResult, string>(
                    new SemanticTokensResult()
                );
            }

            var data = await SemanticTokensResolver
                .GetFullAsync(document, ct)
                .ConfigureAwait(false);
            return new SemanticTokensResultType.Ok<SemanticTokensResult, string>(
                new SemanticTokensResult { Data = data }
            );
        }
        catch (Exception ex)
        {
            return SemanticTokensResultType.Failure(ex.Message);
        }
    }

    /// <summary>Get semantic tokens for a range.</summary>
    public async Task<SemanticTokensResultType> GetSemanticTokensRangeAsync(
        string filePath,
        int startLine,
        int startCharacter,
        int endLine,
        int endCharacter,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new SemanticTokensResultType.Ok<SemanticTokensResult, string>(
                    new SemanticTokensResult()
                );
            }

            var data = await SemanticTokensResolver
                .GetRangeAsync(document, startLine, startCharacter, endLine, endCharacter, ct)
                .ConfigureAwait(false);
            return new SemanticTokensResultType.Ok<SemanticTokensResult, string>(
                new SemanticTokensResult { Data = data }
            );
        }
        catch (Exception ex)
        {
            return SemanticTokensResultType.Failure(ex.Message);
        }
    }

    /// <summary>Get inlay hints for a range.</summary>
    public async Task<InlayHintsResult> GetInlayHintsAsync(
        string filePath,
        int startLine,
        int endLine,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new InlayHintsResult.Ok<List<InlayHintResult>, string>([]);
            }

            var hints = await InlayHintResolver
                .GetHintsAsync(document, startLine, endLine, ct)
                .ConfigureAwait(false);
            return new InlayHintsResult.Ok<List<InlayHintResult>, string>(hints);
        }
        catch (Exception ex)
        {
            return InlayHintsResult.Failure(ex.Message);
        }
    }
}
