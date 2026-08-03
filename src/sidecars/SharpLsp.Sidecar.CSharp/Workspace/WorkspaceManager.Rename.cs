using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using PrepareRenameQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.PrepareRenameResult,
    string
>;
using RenameEditResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    private readonly record struct RenameTarget(
        Document Document,
        SourceText Text,
        ISymbol Symbol,
        SyntaxToken Token
    );

    // Implements [RENAME-PREPARE]
    /// <summary>Check whether the source identifier at the position can be renamed.</summary>
    public async Task<PrepareRenameQueryResult> PrepareRenameAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var target = await FindRenameTargetAsync(filePath, line, character, ct)
                .ConfigureAwait(false);
            return PrepareResult(target);
        }
        catch (Exception ex)
        {
            return PrepareRenameQueryResult.Failure(ex.Message);
        }
    }

    // Implements [RENAME-APPLY]
    /// <summary>Rename a source identifier and return granular edits for every use.</summary>
    public async Task<RenameEditResult> RenameAsync(
        string filePath,
        int line,
        int character,
        string newName,
        CancellationToken ct = default
    )
    {
        try
        {
            return await RenameCoreAsync(filePath, line, character, newName, ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return RenameEditResult.Failure(ex.Message);
        }
    }

    private async Task<RenameEditResult> RenameCoreAsync(
        string filePath,
        int line,
        int character,
        string newName,
        CancellationToken ct
    )
    {
        var target = await FindRenameTargetAsync(filePath, line, character, ct)
            .ConfigureAwait(false);
        if (target is null || _solution is null || !CanUseNewName(target.Value, newName))
        {
            return EmptyRenameResult();
        }

        var renamed = await RenameSolutionAsync(_solution, target.Value.Symbol, newName, ct)
            .ConfigureAwait(false);
        return await BuildRenameResultAsync(_solution, renamed, ct).ConfigureAwait(false);
    }

    private async Task<RenameTarget?> FindRenameTargetAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Document not found");
        return await FindRenameTargetAsync(document, line, character, ct).ConfigureAwait(false);
    }

    private static async Task<RenameTarget?> FindRenameTargetAsync(
        Document document,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var position = text.Lines.GetPosition(new LinePosition(line, character));
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var token = root?.FindToken(position);
        if (!IsIdentifierAtPosition(token, position))
        {
            return null;
        }

        var symbol = await FindSymbolAsync(document, position, ct).ConfigureAwait(false);
        var targetSymbol = symbol is null ? null : RenameConflictTarget(symbol);
        return targetSymbol is not null && IsSourceSymbol(targetSymbol)
            ? new RenameTarget(document, text, targetSymbol, token!.Value)
            : null;
    }

    private static async Task<ISymbol?> FindSymbolAsync(
        Document document,
        int position,
        CancellationToken ct
    )
    {
        return await Microsoft.CodeAnalysis.FindSymbols.SymbolFinder
            .FindSymbolAtPositionAsync(document, position, ct)
            .ConfigureAwait(false);
    }

    private static bool IsIdentifierAtPosition(SyntaxToken? token, int position)
    {
        return token is { RawKind: (int)SyntaxKind.IdentifierToken }
            && token.Value.Span.Contains(position);
    }

    private static bool IsSourceSymbol(ISymbol symbol)
    {
        return symbol.Locations.Any(location => location.IsInSource);
    }

    private static PrepareRenameQueryResult PrepareResult(RenameTarget? target)
    {
        if (target is null)
        {
            return PrepareSuccess(new PrepareRenameResult { CanRename = false });
        }

        var lineSpan = target.Value.Text.Lines.GetLinePositionSpan(target.Value.Token.Span);
        return PrepareSuccess(CreatePrepareResult(target.Value.Token.Text, lineSpan));
    }

    private static PrepareRenameResult CreatePrepareResult(
        string placeholder,
        LinePositionSpan span
    )
    {
        return new PrepareRenameResult
        {
            CanRename = true,
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character,
            Placeholder = placeholder,
        };
    }

    private static PrepareRenameQueryResult PrepareSuccess(PrepareRenameResult result)
    {
        return new PrepareRenameQueryResult.Ok<PrepareRenameResult, string>(result);
    }

    private static bool CanUseNewName(RenameTarget target, string newName)
    {
        if (!IsValidIdentifier(newName) || newName == target.Token.Text)
        {
            return false;
        }

        var valueText = SyntaxFactory.ParseToken(newName).ValueText;
        return !HasDeclarationConflict(target.Symbol, valueText);
    }

    private static bool IsValidIdentifier(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        var token = SyntaxFactory.ParseToken(name);
        return token.IsKind(SyntaxKind.IdentifierToken)
            && token.Text == name
            && token.LeadingTrivia.Count == 0
            && token.TrailingTrivia.Count == 0;
    }

    private static bool HasDeclarationConflict(ISymbol symbol, string valueText)
    {
        var target = RenameConflictTarget(symbol);
        return target.ContainingType is { } type
            ? HasDifferentSymbol(type.GetMembers(valueText), target)
            : target is INamedTypeSymbol named
                ? HasNamedTypeConflict(named, valueText)
                : target is INamespaceSymbol ns && HasNamespaceConflict(ns, valueText);
    }

    private static ISymbol RenameConflictTarget(ISymbol symbol)
    {
        return symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor
            ? constructor.ContainingType
            : symbol;
    }

    private static bool HasDifferentSymbol(IEnumerable<ISymbol> candidates, ISymbol target)
    {
        return candidates.Any(candidate => !SymbolEqualityComparer.Default.Equals(candidate, target));
    }

    private static bool HasNamedTypeConflict(INamedTypeSymbol symbol, string valueText)
    {
        var candidates = symbol.ContainingType?.GetTypeMembers(valueText).Cast<ISymbol>()
            ?? symbol.ContainingNamespace.GetTypeMembers(valueText);
        return HasDifferentSymbol(candidates, symbol);
    }

    private static bool HasNamespaceConflict(INamespaceSymbol symbol, string valueText)
    {
        return HasDifferentSymbol(
            symbol.ContainingNamespace.GetMembers(valueText),
            symbol
        );
    }

    private static Task<Solution> RenameSolutionAsync(
        Solution solution,
        ISymbol symbol,
        string newName,
        CancellationToken ct
    )
    {
        return Microsoft.CodeAnalysis.Rename.Renamer.RenameSymbolAsync(
            solution,
            symbol,
            new Microsoft.CodeAnalysis.Rename.SymbolRenameOptions(),
            newName,
            ct
        );
    }

    private static async Task<RenameEditResult> BuildRenameResultAsync(
        Solution original,
        Solution renamed,
        CancellationToken ct
    )
    {
        var edits = new List<DocumentEditResult>();
        foreach (var projectChange in renamed.GetChanges(original).GetProjectChanges())
        {
            await AddChangedDocumentsAsync(original, renamed, projectChange, edits, ct)
                .ConfigureAwait(false);
        }

        return RenameSuccess(new WorkspaceEditResult { DocumentChanges = edits });
    }

    private static async Task AddChangedDocumentsAsync(
        Solution original,
        Solution renamed,
        ProjectChanges projectChange,
        List<DocumentEditResult> result,
        CancellationToken ct
    )
    {
        foreach (var documentId in projectChange.GetChangedDocuments())
        {
            var edit = await BuildDocumentRenameEditAsync(original, renamed, documentId, ct)
                .ConfigureAwait(false);
            if (edit is not null)
            {
                result.Add(edit);
            }
        }
    }

    private static async Task<DocumentEditResult?> BuildDocumentRenameEditAsync(
        Solution original,
        Solution renamed,
        DocumentId documentId,
        CancellationToken ct
    )
    {
        var oldDocument = original.GetDocument(documentId);
        var newDocument = renamed.GetDocument(documentId);
        if (oldDocument?.FilePath is null || newDocument is null)
        {
            return null;
        }

        var edits = await DocumentText.ComputeEditsAsync(oldDocument, newDocument, ct)
            .ConfigureAwait(false);
        return edits.Count == 0
            ? null
            : new DocumentEditResult { FilePath = oldDocument.FilePath, Edits = edits };
    }

    private static RenameEditResult EmptyRenameResult()
    {
        return RenameSuccess(new WorkspaceEditResult());
    }

    private static RenameEditResult RenameSuccess(WorkspaceEditResult edit)
    {
        return new RenameEditResult.Ok<WorkspaceEditResult, string>(edit);
    }
}
