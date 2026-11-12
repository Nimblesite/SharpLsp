using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using RenameEditResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    // [RENAME-COVERAGE] Only a real operator declaration or bound expression can start this rename.
    private static bool IsOperatorAtPosition(SyntaxToken token, int position)
    {
        return token.IsKind(SyntaxKind.PlusToken)
            && token.Span.Contains(position)
            && ((token.Parent is OperatorDeclarationSyntax declaration && declaration.OperatorToken == token)
                || (token.Parent is BinaryExpressionSyntax binary && binary.OperatorToken == token));
    }

    private static bool IsValidOperatorChange(RenameTarget target, string newName)
    {
        var replacement = SyntaxFactory.ParseToken(newName);
        return target.Symbol is IMethodSymbol { MethodKind: MethodKind.UserDefinedOperator } method
            && method.Parameters.Length == 2
            && target.Token.IsKind(SyntaxKind.PlusToken)
            && replacement.IsKind(SyntaxKind.MinusToken)
            && replacement.Text == newName
            && !method.ContainingType.GetMembers("op_Subtraction").OfType<IMethodSymbol>()
                .Any(other => SymbolSignatureComparer.SameMethod(method, other));
    }

    private static async Task<RenameEditResult> RenameOperatorAsync(
        Solution solution, RenameTarget target, string newName, CancellationToken ct)
    {
        if (!IsValidOperatorChange(target, newName))
        {
            return RenameEditResult.Failure("Invalid C# operator rename");
        }
        var edits = new Dictionary<DocumentId, List<TextEditResult>>();
        if (!await AddOperatorDeclarationsAsync(solution, target.Symbol, edits, newName, ct).ConfigureAwait(false))
        {
            return RenameEditResult.Failure("C# operator rename has an unmappable declaration");
        }
        var references = await SymbolFinder.FindReferencesAsync(target.Symbol, solution, cancellationToken: ct)
            .ConfigureAwait(false);
        if (!await AddOperatorReferencesAsync(references, edits, newName, ct).ConfigureAwait(false))
        {
            return RenameEditResult.Failure("C# operator rename has an unmappable reference");
        }
        var documents = OperatorDocumentEdits(solution, edits);
        return documents is null
            ? RenameEditResult.Failure("C# operator rename has an unmappable document")
            : RenameSuccess(new WorkspaceEditResult(documents));
    }

    private static async Task<bool> AddOperatorDeclarationsAsync(
        Solution solution,
        ISymbol symbol,
        Dictionary<DocumentId, List<TextEditResult>> edits,
        string newName,
        CancellationToken ct)
    {
        foreach (var syntax in symbol.DeclaringSyntaxReferences)
        {
            var document = solution.GetDocument(syntax.SyntaxTree);
            var declaration = await syntax.GetSyntaxAsync(ct).ConfigureAwait(false) as OperatorDeclarationSyntax;
            if (document is null || declaration?.OperatorToken.IsKind(SyntaxKind.PlusToken) != true)
            {
                return false;
            }
            var text = await document.GetTextAsync(ct).ConfigureAwait(false);
            var edit = DocumentText.ToTextEdit(text, new TextChange(declaration.OperatorToken.Span, newName));
            if (!edits.TryGetValue(document.Id, out var documentEdits))
            {
                edits[document.Id] = documentEdits = [];
            }
            documentEdits.Add(edit);
        }
        return symbol.DeclaringSyntaxReferences.Length > 0;
    }

    private static async Task<bool> AddOperatorReferencesAsync(
        IEnumerable<ReferencedSymbol> references,
        Dictionary<DocumentId, List<TextEditResult>> edits,
        string newName,
        CancellationToken ct)
    {
        foreach (var reference in references.SelectMany(item => item.Locations))
        {
            var edit = await OperatorReferenceEditAsync(reference, newName, ct).ConfigureAwait(false);
            if (edit is null)
            {
                return false;
            }
            if (!edits.TryGetValue(reference.Document.Id, out var documentEdits))
            {
                edits[reference.Document.Id] = documentEdits = [];
            }
            documentEdits.Add(edit);
        }
        return true;
    }

    private static async Task<TextEditResult?> OperatorReferenceEditAsync(
        ReferenceLocation reference, string newName, CancellationToken ct)
    {
        var root = await reference.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        if (root is null || reference.IsImplicit)
        {
            return null;
        }
        var span = reference.Location.SourceSpan;
        var token = root.FindToken(span.Start);
        var compound = token.IsKind(SyntaxKind.PlusEqualsToken)
            && token.Parent is AssignmentExpressionSyntax assignment
            && assignment.OperatorToken == token;
        if ((!IsOperatorAtPosition(token, span.Start) && !compound) || token.Span != span)
        {
            return null;
        }
        var text = await reference.Document.GetTextAsync(ct).ConfigureAwait(false);
        return DocumentText.ToTextEdit(text, new TextChange(token.Span, compound ? newName + "=" : newName));
    }

    private static List<DocumentEditResult>? OperatorDocumentEdits(
        Solution solution, Dictionary<DocumentId, List<TextEditResult>> edits)
    {
        var documents = new List<DocumentEditResult>();
        foreach (var (id, items) in edits)
        {
            var path = solution.GetDocument(id)?.FilePath;
            if (path is null)
            {
                return null;
            }
            documents.Add(new DocumentEditResult(path, [.. items.DistinctBy(EditLocation)], false, null));
        }
        return documents;
    }
}
