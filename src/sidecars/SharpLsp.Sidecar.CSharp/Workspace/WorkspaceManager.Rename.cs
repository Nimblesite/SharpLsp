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

    private readonly record struct RenameSolutions(
        Solution Original,
        Solution Renamed,
        string NewName
    );

    private readonly record struct RenameDocuments(Document Old, Document New, string NewName);

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
        return await BuildRenameResultAsync(_solution, renamed, newName, ct).ConfigureAwait(false);
    }

    private async Task<RenameTarget?> FindRenameTargetAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var document =
            await FindDocumentAsync(filePath, ct).ConfigureAwait(false)
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
        return await Microsoft
            .CodeAnalysis.FindSymbols.SymbolFinder.FindSymbolAtPositionAsync(document, position, ct)
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
        if (CanShadowContainingTypeMembers(symbol))
        {
            return false;
        }

        var target = RenameConflictTarget(symbol);
        return target.ContainingType is { } type
                ? HasDifferentSymbol(type.GetMembers(valueText), target)
            : target is INamedTypeSymbol named ? HasNamedTypeConflict(named, valueText)
            : target is INamespaceSymbol ns && HasNamespaceConflict(ns, valueText);
    }

    /// <summary>
    /// Locals, parameters, type parameters and range variables legally shadow a
    /// same-named member of the enclosing type, so a member collision is not a
    /// redeclaration conflict for them. <see cref="ISymbol.ContainingType"/> is
    /// non-null for all of these (it is the type owning the enclosing method), so
    /// without this guard the member scan below would reject a legal rename and
    /// return an empty edit — which the host maps to LSP <c>null</c>, making the
    /// rename silently do nothing. Their real scope conflicts are detected by
    /// Roslyn's <c>Renamer</c>, which is what resolves them.
    /// </summary>
    private static bool CanShadowContainingTypeMembers(ISymbol symbol)
    {
        return symbol.Kind
            is SymbolKind.Local
                or SymbolKind.Parameter
                or SymbolKind.TypeParameter
                or SymbolKind.RangeVariable;
    }

    private static ISymbol RenameConflictTarget(ISymbol symbol)
    {
        return symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor
            ? constructor.ContainingType
            : symbol;
    }

    private static bool HasDifferentSymbol(IEnumerable<ISymbol> candidates, ISymbol target)
    {
        return candidates.Any(candidate =>
            !SymbolEqualityComparer.Default.Equals(candidate, target)
        );
    }

    private static bool HasNamedTypeConflict(INamedTypeSymbol symbol, string valueText)
    {
        var candidates =
            symbol.ContainingType?.GetTypeMembers(valueText).Cast<ISymbol>()
            ?? symbol.ContainingNamespace.GetTypeMembers(valueText);
        return HasDifferentSymbol(candidates, symbol);
    }

    private static bool HasNamespaceConflict(INamespaceSymbol symbol, string valueText)
    {
        return HasDifferentSymbol(symbol.ContainingNamespace.GetMembers(valueText), symbol);
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
        string newName,
        CancellationToken ct
    )
    {
        var edits = new List<DocumentEditResult>();
        var solutions = new RenameSolutions(original, renamed, newName);
        foreach (var projectChange in renamed.GetChanges(original).GetProjectChanges())
        {
            await AddChangedDocumentsAsync(solutions, projectChange, edits, ct)
                .ConfigureAwait(false);
        }

        return RenameSuccess(new WorkspaceEditResult { DocumentChanges = edits });
    }

    private static async Task AddChangedDocumentsAsync(
        RenameSolutions solutions,
        ProjectChanges projectChange,
        List<DocumentEditResult> result,
        CancellationToken ct
    )
    {
        foreach (var documentId in projectChange.GetChangedDocuments())
        {
            var edit = await BuildDocumentRenameEditAsync(solutions, documentId, ct)
                .ConfigureAwait(false);
            if (edit is not null)
            {
                result.Add(edit);
            }
        }
    }

    private static async Task<DocumentEditResult?> BuildDocumentRenameEditAsync(
        RenameSolutions solutions,
        DocumentId documentId,
        CancellationToken ct
    )
    {
        var documents = GetRenameDocuments(solutions, documentId);
        return documents is null
            ? null
            : await CreateDocumentRenameEditAsync(documents.Value, ct).ConfigureAwait(false);
    }

    private static RenameDocuments? GetRenameDocuments(
        RenameSolutions solutions,
        DocumentId documentId
    )
    {
        var oldDocument = solutions.Original.GetDocument(documentId);
        var newDocument = solutions.Renamed.GetDocument(documentId);
        return oldDocument?.FilePath is null || newDocument is null
            ? null
            : new RenameDocuments(oldDocument, newDocument, solutions.NewName);
    }

    private static async Task<DocumentEditResult?> CreateDocumentRenameEditAsync(
        RenameDocuments documents,
        CancellationToken ct
    )
    {
        var edits = await ComputeRenameEditsAsync(
                documents.Old,
                documents.New,
                documents.NewName,
                ct
            )
            .ConfigureAwait(false);
        return edits.Count == 0
            ? null
            : new DocumentEditResult { FilePath = documents.Old.FilePath!, Edits = edits };
    }

    private static async Task<List<TextEditResult>> ComputeRenameEditsAsync(
        Document oldDocument,
        Document newDocument,
        string newName,
        CancellationToken ct
    )
    {
        var oldText = await oldDocument.GetTextAsync(ct).ConfigureAwait(false);
        var oldRoot = await oldDocument.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var changes = await newDocument.GetTextChangesAsync(oldDocument, ct).ConfigureAwait(false);
        return
        [
            .. changes
                .Select(change => ExpandRenameEdit(oldText, oldRoot, change, newName))
                .DistinctBy(EditLocation),
        ];
    }

    private static TextEditResult ExpandRenameEdit(
        SourceText oldText,
        SyntaxNode? oldRoot,
        TextChange change,
        string newName
    )
    {
        var token = FindChangedIdentifier(oldRoot, change, newName);
        var expanded = token.RawKind == 0 ? change : new TextChange(token.Span, newName);
        return DocumentText.ToTextEdit(oldText, expanded);
    }

    private static SyntaxToken FindChangedIdentifier(
        SyntaxNode? root,
        TextChange change,
        string newName
    )
    {
        return root is null
            ? default
            : ChangeCandidatePositions(root, change)
                .Select(position => root.FindToken(position, findInsideTrivia: true))
                .FirstOrDefault(token => RewritesIdentifierTo(token, change, newName));
    }

    private static IEnumerable<int> ChangeCandidatePositions(SyntaxNode root, TextChange change)
    {
        return new[]
        {
            change.Span.Start,
            change.Span.End,
            change.Span.Start - 1,
            change.Span.End - 1,
        }
            .Where(position => position >= 0 && position < root.FullSpan.End)
            .Distinct();
    }

    private static bool RewritesIdentifierTo(SyntaxToken token, TextChange change, string newName)
    {
        if (!token.IsKind(SyntaxKind.IdentifierToken) || !token.Span.Contains(change.Span))
        {
            return false;
        }

        var start = change.Span.Start - token.Span.Start;
        var end = change.Span.End - token.Span.Start;
        var rewritten = token.Text[..start] + (change.NewText ?? "") + token.Text[end..];
        return string.Equals(rewritten, newName, StringComparison.Ordinal);
    }

    private static (int, int, int, int) EditLocation(TextEditResult edit)
    {
        return (edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter);
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
