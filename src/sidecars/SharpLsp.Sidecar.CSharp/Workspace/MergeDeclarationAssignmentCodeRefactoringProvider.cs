using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Editing;
using Microsoft.CodeAnalysis.Formatting;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Merges an uninitialized local declaration with its immediately following assignment.
/// Implements [SHARPLSP-FEATURES-REFACTORING].
/// </summary>
internal sealed class MergeDeclarationAssignmentCodeRefactoringProvider : CodeRefactoringProvider
{
    private const string Title = "Merge declaration and assignment";
    private const string EquivalenceKey = nameof(MergeDeclarationAssignmentCodeRefactoringProvider);

    public override async Task ComputeRefactoringsAsync(CodeRefactoringContext context)
    {
        var root = await context
            .Document.GetSyntaxRootAsync(context.CancellationToken)
            .ConfigureAwait(false);
        var candidate = root is null ? null : FindCandidate(root, context.Span.Start);
        if (candidate is null)
        {
            return;
        }

        var model = await context
            .Document.GetSemanticModelAsync(context.CancellationToken)
            .ConfigureAwait(false);
        if (model is null || !TargetsDeclaredLocal(model, candidate, context.CancellationToken))
        {
            return;
        }

        context.RegisterRefactoring(CreateAction(context.Document, candidate));
    }

    private static CodeAction CreateAction(Document document, Candidate candidate)
    {
        return CodeAction.Create(
            Title,
            cancellationToken => ApplyAsync(document, candidate, cancellationToken),
            EquivalenceKey
        );
    }

    private static Candidate? FindCandidate(SyntaxNode root, int position)
    {
        var statement = root.FindToken(position).Parent?.FirstAncestorOrSelf<StatementSyntax>();
        return statement switch
        {
            LocalDeclarationStatementSyntax declaration => FromDeclaration(declaration),
            ExpressionStatementSyntax assignment => FromAssignment(assignment),
            _ => null,
        };
    }

    private static Candidate? FromDeclaration(LocalDeclarationStatementSyntax declaration)
    {
        return AdjacentStatement(declaration, 1) is ExpressionStatementSyntax assignment
            ? CreateCandidate(declaration, assignment)
            : null;
    }

    private static Candidate? FromAssignment(ExpressionStatementSyntax assignment)
    {
        return AdjacentStatement(assignment, -1) is LocalDeclarationStatementSyntax declaration
            ? CreateCandidate(declaration, assignment)
            : null;
    }

    private static Candidate? CreateCandidate(
        LocalDeclarationStatementSyntax declaration,
        ExpressionStatementSyntax assignmentStatement
    )
    {
        return
            IsEligibleDeclaration(declaration)
            && !assignmentStatement.ContainsDirectives
            && HasSafeTrivia(declaration, assignmentStatement)
            && assignmentStatement.Expression is AssignmentExpressionSyntax assignment
            && assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
            && assignment.Left is IdentifierNameSyntax target
            ? new Candidate(
                declaration,
                assignmentStatement,
                declaration.Declaration.Variables[0],
                assignment,
                target
            )
            : null;
    }

    private static bool HasSafeTrivia(
        LocalDeclarationStatementSyntax declaration,
        ExpressionStatementSyntax assignment
    )
    {
        return IsLayoutTrivia(declaration.GetTrailingTrivia())
            && IsLayoutTrivia(assignment.GetLeadingTrivia());
    }

    private static bool IsLayoutTrivia(SyntaxTriviaList trivia)
    {
        return trivia.All(item =>
            item.IsKind(SyntaxKind.WhitespaceTrivia) || item.IsKind(SyntaxKind.EndOfLineTrivia)
        );
    }

    private static bool IsEligibleDeclaration(LocalDeclarationStatementSyntax declaration)
    {
        return declaration.Modifiers.Count == 0
            && declaration.UsingKeyword.RawKind == 0
            && declaration.AwaitKeyword.RawKind == 0
            && !declaration.ContainsDirectives
            && declaration.Declaration.Variables.Count == 1
            && declaration.Declaration.Variables[0].Initializer is null;
    }

    private static StatementSyntax? AdjacentStatement(StatementSyntax statement, int offset)
    {
        var statements = ContainingStatements(statement);
        var adjacentIndex = statements.IndexOf(statement) + offset;
        return adjacentIndex >= 0 && adjacentIndex < statements.Count
            ? statements[adjacentIndex]
            : null;
    }

    private static SyntaxList<StatementSyntax> ContainingStatements(StatementSyntax statement)
    {
        return statement.Parent switch
        {
            BlockSyntax block => block.Statements,
            SwitchSectionSyntax section => section.Statements,
            _ => default,
        };
    }

    private static bool TargetsDeclaredLocal(
        SemanticModel model,
        Candidate candidate,
        CancellationToken cancellationToken
    )
    {
        var local = model.GetDeclaredSymbol(candidate.Variable, cancellationToken) as ILocalSymbol;
        var target = model.GetSymbolInfo(candidate.Target, cancellationToken).Symbol;
        return local is not null && SymbolEqualityComparer.Default.Equals(local, target);
    }

    private static async Task<Document> ApplyAsync(
        Document document,
        Candidate candidate,
        CancellationToken cancellationToken
    )
    {
        var root = await document.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (root is null)
        {
            return document;
        }

        var editor = new SyntaxEditor(root, document.Project.Solution.Workspace.Services);
        editor.ReplaceNode(candidate.Declaration, Merge(candidate));
        editor.RemoveNode(candidate.AssignmentStatement, SyntaxRemoveOptions.KeepNoTrivia);
        return document.WithSyntaxRoot(editor.GetChangedRoot());
    }

    private static LocalDeclarationStatementSyntax Merge(Candidate candidate)
    {
        var initializer = SyntaxFactory.EqualsValueClause(
            AssignmentOperator(candidate),
            candidate.Assignment.Right
        );
        var variable = candidate.Variable.WithInitializer(initializer);
        var declaration = candidate.Declaration.Declaration.WithVariables(
            SyntaxFactory.SingletonSeparatedList(variable)
        );
        return candidate
            .Declaration.WithDeclaration(declaration)
            .WithLeadingTrivia(candidate.Declaration.GetLeadingTrivia())
            .WithTrailingTrivia(MergedTrailingTrivia(candidate))
            .WithAdditionalAnnotations(Formatter.Annotation);
    }

    private static SyntaxToken AssignmentOperator(Candidate candidate)
    {
        var leadingTrivia = candidate
            .Target.GetTrailingTrivia()
            .AddRange(candidate.Assignment.OperatorToken.LeadingTrivia);
        return candidate.Assignment.OperatorToken.WithLeadingTrivia(leadingTrivia);
    }

    private static SyntaxTriviaList MergedTrailingTrivia(Candidate candidate)
    {
        return candidate.AssignmentStatement.GetTrailingTrivia();
    }

    private sealed record Candidate(
        LocalDeclarationStatementSyntax Declaration,
        ExpressionStatementSyntax AssignmentStatement,
        VariableDeclaratorSyntax Variable,
        AssignmentExpressionSyntax Assignment,
        IdentifierNameSyntax Target
    );
}
