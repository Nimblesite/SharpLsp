using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using RenameEditResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// [RENAME-COVERAGE] Renaming an operator respells it: <c>+</c> to <c>-</c> on its declaration
/// and every bound use, compound assignments included; a conversion's <c>implicit</c> to
/// <c>explicit</c> casts every use that relied on it. The compiler is the judge: an edit that
/// adds an error (a duplicate signature, an unpaired <c>==</c>, a wrong return type) is refused
/// with that error. [RENAME-ERRORS]
/// </summary>
internal sealed partial class WorkspaceManager
{
    // Only a real operator declaration, a bound operator expression or a conversion's
    // implicit/explicit keyword can start this rename.
    private static bool IsOperatorAtPosition(SyntaxToken token, int position)
    {
        return token.Span.Contains(position)
            && token.Parent switch
            {
                OperatorDeclarationSyntax declaration => declaration.OperatorToken == token,
                ConversionOperatorDeclarationSyntax conversion =>
                    conversion.ImplicitOrExplicitKeyword == token,
                BinaryExpressionSyntax binary => binary.OperatorToken == token,
                AssignmentExpressionSyntax assignment => assignment.OperatorToken == token
                    && !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression),
                PrefixUnaryExpressionSyntax prefix => prefix.OperatorToken == token,
                PostfixUnaryExpressionSyntax postfix => postfix.OperatorToken == token,
                _ => false,
            };
    }

    private static bool IsOperatorSymbol(ISymbol symbol)
    {
        return symbol is IMethodSymbol method
            && method.MethodKind is MethodKind.UserDefinedOperator or MethodKind.Conversion;
    }

    /// <summary>The operator an operator token declares or binds to; null for a built-in one.</summary>
    private static async Task<ISymbol?> FindOperatorSymbolAsync(
        Document document,
        SyntaxToken token,
        CancellationToken ct
    )
    {
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return token.Parent switch
        {
            null => null,
            BaseMethodDeclarationSyntax declaration => model?.GetDeclaredSymbol(declaration, ct),
            var expression => model?.GetSymbolInfo(expression, ct).Symbol,
        };
    }

    /// <summary>Whether <paramref name="newName"/> spells an operator of the same shape.</summary>
    private static bool IsOperatorSpelling(IMethodSymbol method, string newName)
    {
        if (method.MethodKind == MethodKind.Conversion)
        {
            return newName is "implicit" or "explicit";
        }
        var replacement = SyntaxFactory.ParseToken(newName);
        return replacement.Text == newName
            && (
                method.Parameters.Length == 1
                    ? SyntaxFacts.IsOverloadableUnaryOperator(replacement.Kind())
                    : SyntaxFacts.IsOverloadableBinaryOperator(replacement.Kind())
            );
    }

    private static async Task<RenameEditResult> RenameOperatorAsync(
        Solution solution,
        RenameTarget target,
        string newName,
        CancellationToken ct
    )
    {
        var method = (IMethodSymbol)target.Symbol;
        if (newName == target.Token.Text)
        {
            return EmptyRenameResult();
        }
        if (!IsOperatorSpelling(method, newName))
        {
            return RenameEditResult.Failure("Invalid C# operator rename");
        }
        var changes = new Dictionary<DocumentId, List<TextChange>>();
        var mapped =
            await AddOperatorDeclarationsAsync(solution, method, changes, newName, ct)
                .ConfigureAwait(false)
            && await AddOperatorReferencesAsync(solution, method, changes, newName, ct)
                .ConfigureAwait(false);
        return mapped
            ? await VerifiedOperatorEditAsync(solution, changes, ct).ConfigureAwait(false)
            : RenameEditResult.Failure("C# operator rename has an unmappable location");
    }

    private static void AddChange(
        Dictionary<DocumentId, List<TextChange>> changes,
        DocumentId document,
        TextChange change
    )
    {
        if (!changes.TryGetValue(document, out var list))
        {
            changes[document] = list = [];
        }
        if (!list.Exists(existing => existing.Span == change.Span))
        {
            list.Add(change);
        }
    }

    /// <summary>The token a declaration spells its operator with.</summary>
    private static SyntaxToken? DeclaredOperatorToken(SyntaxNode? declaration)
    {
        return declaration switch
        {
            OperatorDeclarationSyntax operatorDeclaration => operatorDeclaration.OperatorToken,
            ConversionOperatorDeclarationSyntax conversion => conversion.ImplicitOrExplicitKeyword,
            _ => null,
        };
    }

    private static async Task<bool> AddOperatorDeclarationsAsync(
        Solution solution,
        IMethodSymbol method,
        Dictionary<DocumentId, List<TextChange>> changes,
        string newName,
        CancellationToken ct
    )
    {
        foreach (var syntax in method.DeclaringSyntaxReferences)
        {
            var document = solution.GetDocument(syntax.SyntaxTree);
            var token = DeclaredOperatorToken(
                await syntax.GetSyntaxAsync(ct).ConfigureAwait(false)
            );
            if (document is null || token is null)
            {
                return false;
            }
            AddChange(changes, document.Id, new TextChange(token.Value.Span, newName));
        }
        return method.DeclaringSyntaxReferences.Length > 0;
    }

    private static async Task<bool> AddOperatorReferencesAsync(
        Solution solution,
        IMethodSymbol method,
        Dictionary<DocumentId, List<TextChange>> changes,
        string newName,
        CancellationToken ct
    )
    {
        if (method.MethodKind == MethodKind.Conversion)
        {
            return newName == "implicit"
                || await AddConversionCastsAsync(solution, method, changes, ct)
                    .ConfigureAwait(false);
        }
        var references = await SymbolFinder
            .FindReferencesAsync(method, solution, cancellationToken: ct)
            .ConfigureAwait(false);
        foreach (var reference in references.SelectMany(item => item.Locations))
        {
            var change = await OperatorUseChangeAsync(reference, newName, ct).ConfigureAwait(false);
            if (change is null)
            {
                return false;
            }
            AddChange(changes, reference.Document.Id, change.Value);
        }
        return true;
    }

    /// <summary>The respelled token of one bound use; null when the use has no token to respell.</summary>
    private static async Task<TextChange?> OperatorUseChangeAsync(
        ReferenceLocation reference,
        string newName,
        CancellationToken ct
    )
    {
        var root = await reference.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var span = reference.Location.SourceSpan;
        if (root is null || reference.IsImplicit)
        {
            return null;
        }
        var token = root.FindToken(span.Start);
        var respelled = token.Parent is AssignmentExpressionSyntax ? newName + "=" : newName;
        return IsOperatorAtPosition(token, span.Start) && token.Span == span
            ? new TextChange(span, respelled)
            : null;
    }

    /// <summary>
    /// A conversion turning explicit: every expression the compiler converts through it
    /// implicitly gains the cast, in each project that can see the conversion. A cast already
    /// written binds to it explicitly and stays as it is.
    /// </summary>
    private static async Task<bool> AddConversionCastsAsync(
        Solution solution,
        IMethodSymbol method,
        Dictionary<DocumentId, List<TextChange>> changes,
        CancellationToken ct
    )
    {
        var home = solution.GetProject(method.ContainingAssembly, ct);
        var dependents = home is null
            ? []
            : solution
                .GetProjectDependencyGraph()
                .GetProjectsThatTransitivelyDependOnThisProject(home.Id);
        var documents = solution
            .Projects.Where(project => project.Id == home?.Id || dependents.Contains(project.Id))
            .SelectMany(project => project.Documents);
        foreach (var document in documents)
        {
            foreach (
                var change in await ConversionCastsAsync(document, method, ct).ConfigureAwait(false)
            )
            {
                AddChange(changes, document.Id, change);
            }
        }
        return home is not null;
    }

    /// <summary>The casts one document needs: one per expression converted through <paramref name="method"/>.</summary>
    private static async Task<List<TextChange>> ConversionCastsAsync(
        Document document,
        IMethodSymbol method,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        var model = await document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return root is null || model is null ? [] : ConversionCasts(root, model, method, ct);
    }

    private static List<TextChange> ConversionCasts(
        SyntaxNode root,
        SemanticModel model,
        IMethodSymbol method,
        CancellationToken ct
    )
    {
        return
        [
            .. root.DescendantNodes()
                .OfType<ExpressionSyntax>()
                .Where(expression =>
                    SymbolEqualityComparer.Default.Equals(
                        model.GetConversion(expression, ct).MethodSymbol?.OriginalDefinition,
                        method.OriginalDefinition
                    )
                )
                .Select(expression => new TextChange(
                    expression.Span,
                    $"({method.ReturnType.ToMinimalDisplayString(model, expression.SpanStart)})({expression})"
                )),
        ];
    }

    /// <summary>The edit, when the compiler finds no error the respelling introduced.</summary>
    private static async Task<RenameEditResult> VerifiedOperatorEditAsync(
        Solution solution,
        Dictionary<DocumentId, List<TextChange>> changes,
        CancellationToken ct
    )
    {
        var respelled = solution;
        var documents = new List<DocumentEditResult>();
        foreach (var (id, list) in changes)
        {
            var document = solution.GetDocument(id);
            var text = document is null
                ? null
                : await document.GetTextAsync(ct).ConfigureAwait(false);
            if (document?.FilePath is null || text is null)
            {
                return RenameEditResult.Failure("C# operator rename has an unmappable document");
            }
            respelled = respelled.WithDocumentText(id, text.WithChanges(list));
            var edits = list.Select(change => DocumentText.ToTextEdit(text, change));
            documents.Add(new DocumentEditResult(document.FilePath, [.. edits], false, null));
        }
        var projects = changes.Keys.Select(id => id.ProjectId).Distinct();
        var error = await IntroducedErrorAsync(solution, respelled, projects, ct)
            .ConfigureAwait(false);
        return error is null
            ? RenameSuccess(new WorkspaceEditResult(documents))
            : RenameEditResult.Failure($"Invalid C# operator rename: {error}");
    }

    private static async Task<List<Diagnostic>> CompileErrorsAsync(
        Solution solution,
        ProjectId project,
        CancellationToken ct
    )
    {
        var compilation = solution.GetProject(project) is { } found
            ? await found.GetCompilationAsync(ct).ConfigureAwait(false)
            : null;
        return
        [
            .. (compilation?.GetDiagnostics(ct) ?? []).Where(diagnostic =>
                diagnostic.Severity == DiagnosticSeverity.Error
            ),
        ];
    }

    /// <summary>The first compile error <paramref name="after"/> has that <paramref name="before"/> lacked.</summary>
    private static async Task<string?> IntroducedErrorAsync(
        Solution before,
        Solution after,
        IEnumerable<ProjectId> projects,
        CancellationToken ct
    )
    {
        foreach (var project in projects)
        {
            var known = (
                await CompileErrorsAsync(before, project, ct).ConfigureAwait(false)
            ).ConvertAll(diagnostic => diagnostic.Id);
            var now = await CompileErrorsAsync(after, project, ct).ConfigureAwait(false);
            if (now.Find(diagnostic => !known.Remove(diagnostic.Id)) is { } introduced)
            {
                return $"{introduced.Id}: {introduced.GetMessage(CultureInfo.InvariantCulture)}";
            }
        }
        return null;
    }
}
