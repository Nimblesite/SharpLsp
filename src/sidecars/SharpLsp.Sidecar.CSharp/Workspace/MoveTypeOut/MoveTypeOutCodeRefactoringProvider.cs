using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CodeRefactorings;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// "Move 'Inner' out of 'Outer' to Inner.cs": makes a nested type a top-level
/// member of its namespace, in its own file, and rewrites every reference.
/// Implements [REFACTOR-MOVE-TYPE-OUT]; withheld as [REFACTOR-MOVE-TYPE-REFUSED] says.
/// </summary>
internal sealed class MoveTypeOutCodeRefactoringProvider : CodeRefactoringProvider
{
    private const string EquivalenceKey = nameof(MoveTypeOutCodeRefactoringProvider);

    public override async Task ComputeRefactoringsAsync(CodeRefactoringContext context)
    {
        var ct = context.CancellationToken;
        var root = await context.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var declaration = root is null ? null : FindNested(root, context.Span);
        if (declaration is null)
        {
            return;
        }

        var model = await context.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        if (model?.GetDeclaredSymbol(declaration, ct) is not INamedTypeSymbol symbol)
        {
            return;
        }

        Offer(context, new MoveTypeOutTarget(context.Document, declaration, symbol), model);
    }

    private static void Offer(
        CodeRefactoringContext context,
        MoveTypeOutTarget target,
        SemanticModel model
    )
    {
        var blocker = MoveTypeOutBlockers.Find(target, model, context.CancellationToken);
        if (blocker is not null)
        {
            Log.Information(
                "[MoveTypeOut] Not offered for {Type}: {Reason}",
                target.Symbol.Name,
                blocker
            );
            return;
        }

        context.RegisterRefactoring(
            CodeAction.Create(
                target.Title,
                ct => MoveTypeOutRewriter.ApplyAsync(target, ct),
                EquivalenceKey
            )
        );
    }

    /// <summary>A class, struct, record, interface or enum inside a type, whose name the range touches.</summary>
    private static BaseTypeDeclarationSyntax? FindNested(SyntaxNode root, TextSpan span)
    {
        return root.DescendantNodes()
            .OfType<BaseTypeDeclarationSyntax>()
            .FirstOrDefault(declaration =>
                declaration.Parent is TypeDeclarationSyntax
                && DocumentPosition.SpansTouch(declaration.Identifier.Span, span)
            );
    }
}
