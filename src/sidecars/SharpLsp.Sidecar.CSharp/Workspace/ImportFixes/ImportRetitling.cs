using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace.ImportFixes;

/// <summary>An offered import fix under its exact title, and the namespace it imports if any.</summary>
internal sealed record RetitledImport(CodeAction Action, string? Namespace);

/// <summary>
/// Retitles the import fixes a provider offered — Roslyn's <c>AddImport</c> and
/// <c>FullyQualify</c> among them — from the change each makes, read from the syntax tree: the
/// one using directive it adds, or the qualified name that replaces the unresolved one, with the
/// rest of the file untouched. Roslyn's own title text is never read. [REFACTOR-IMPORT-CSHARP]
/// </summary>
internal static class ImportRetitling
{
    /// <summary>The action retitled, or null when its change is not an import of the subject.</summary>
    public static async Task<RetitledImport?> RetitleAsync(
        Document document,
        ImportSubject subject,
        CodeAction action,
        CancellationToken ct
    )
    {
        var changed = await ChangedDocumentAsync(document, action, ct).ConfigureAwait(false);
        if (changed is null)
        {
            return null;
        }
        var before = await RootAsync(document, ct).ConfigureAwait(false);
        var after = await RootAsync(changed, ct).ConfigureAwait(false);
        return AddedUsing(before, after) is { } directive
            ? FromUsing(directive, changed)
            : FromQualified(subject, before, after, changed);
    }

    private static async Task<Document?> ChangedDocumentAsync(
        Document document,
        CodeAction action,
        CancellationToken ct
    )
    {
        var operations = await action.GetOperationsAsync(ct).ConfigureAwait(false);
        return
            operations.OfType<ApplyChangesOperation>().SingleOrDefault() is { } apply
            && OnlyThisDocumentChanged(document, apply.ChangedSolution)
            ? apply.ChangedSolution.GetDocument(document.Id)
            : null;
    }

    private static bool OnlyThisDocumentChanged(Document document, Solution changed)
    {
        var changes = changed.GetChanges(document.Project.Solution).GetProjectChanges().ToList();
        return changes.Count == 1
            && changes[0].GetChangedDocuments().SequenceEqual([document.Id])
            && !changes[0].GetAddedDocuments().Any()
            && !changes[0].GetAddedProjectReferences().Any()
            && !changes[0].GetAddedMetadataReferences().Any();
    }

    private static async Task<CompilationUnitSyntax> RootAsync(
        Document document,
        CancellationToken ct
    )
    {
        var root = await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return root as CompilationUnitSyntax
            ?? throw new InvalidOperationException($"{document.FilePath} has no C# syntax root");
    }

    /// <summary>The one directive <paramref name="after"/> adds, when it adds nothing else.</summary>
    private static UsingDirectiveSyntax? AddedUsing(
        CompilationUnitSyntax before,
        CompilationUnitSyntax after
    )
    {
        var existing = UsingInsertion.AllUsings(before).ToList();
        var added = UsingInsertion
            .AllUsings(after)
            .Where(directive => !existing.Any(old => SyntaxFactory.AreEquivalent(old, directive)))
            .ToList();
        return
            added.Count == 1
            && SyntaxFactory.AreEquivalent(
                before,
                after.RemoveNode(added[0], SyntaxRemoveOptions.KeepNoTrivia)
            )
            ? added[0]
            : null;
    }

    private static RetitledImport FromUsing(UsingDirectiveSyntax directive, Document changed)
    {
        var target = directive.NamespaceOrType.ToString();
        var isStatic = directive.StaticKeyword.IsKind(SyntaxKind.StaticKeyword);
        var title =
            directive.Alias is { } alias
                ? ImportTitles.Alias(alias.Name.Identifier.ValueText, target)
            : isStatic ? ImportTitles.Static(target)
            : ImportTitles.Namespace(target);
        var ns = directive.Alias is null && !isStatic ? target : null;
        return new RetitledImport(Precomputed(title, changed), ns);
    }

    /// <summary>The fully qualified row: only the subject's name changed, into a longer name.</summary>
    private static RetitledImport? FromQualified(
        ImportSubject subject,
        CompilationUnitSyntax before,
        CompilationUnitSyntax after,
        Document changed
    )
    {
        var grown = after.FullSpan.Length - before.FullSpan.Length;
        var span = new TextSpan(subject.Name.SpanStart, subject.Name.Span.Length + grown);
        var replacement = grown > 0 ? after.FindNode(span, getInnermostNodeForTie: false) : null;
        return
            replacement is ExpressionSyntax qualified
            && qualified.Span == span
            && SyntaxFactory.AreEquivalent(before, after.ReplaceNode(qualified, subject.Name))
            ? new RetitledImport(
                Precomputed(
                    ImportTitles.Qualify(subject.Name.ToString(), qualified.ToString()),
                    changed
                ),
                null
            )
            : null;
    }

    /// <summary>An action that hands back the change already computed, under <paramref name="title"/>.</summary>
    private static CodeAction Precomputed(string title, Document changed)
    {
        return CodeAction.Create(title, _ => Task.FromResult(changed), title);
    }
}
