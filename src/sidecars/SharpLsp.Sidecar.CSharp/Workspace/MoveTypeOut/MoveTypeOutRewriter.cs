using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// Produces the solution with a nested type moved out: references shortened in
/// every document, the declaration removed from its container, and the new file
/// added. Implements [REFACTOR-MOVE-TYPE-OUT].
/// </summary>
internal static class MoveTypeOutRewriter
{
    public static async Task<Solution> ApplyAsync(MoveTypeOutTarget target, CancellationToken ct)
    {
        var original = target.Document.Project.Solution;
        var references = await ReferencesByDocumentAsync(target, original, ct)
            .ConfigureAwait(false);
        var moved = await MovedDeclarationAsync(target, ct).ConfigureAwait(false);

        var solution = original;
        foreach (var (documentId, names) in references.Where(r => r.Key != target.Document.Id))
        {
            solution = await ShortenAsync(solution, documentId, names, ct).ConfigureAwait(false);
        }

        var inSource = references.GetValueOrDefault(target.Document.Id, []);
        solution = await RemoveFromSourceAsync(solution, target, inSource, ct).ConfigureAwait(false);
        solution = await AddFileAsync(solution, target, moved, ct).ConfigureAwait(false);
        await MoveTypeOutVerifier.AssertCompilesAsync(target, original, solution, ct)
            .ConfigureAwait(false);
        return solution;
    }

    /// <summary>Every source reference to the moved type, as the name node written, per document.</summary>
    private static async Task<Dictionary<DocumentId, List<SimpleNameSyntax>>> ReferencesByDocumentAsync(
        MoveTypeOutTarget target,
        Solution solution,
        CancellationToken ct
    )
    {
        var found = await SymbolFinder
            .FindReferencesAsync(target.Symbol, solution, ct)
            .ConfigureAwait(false);
        var byDocument = new Dictionary<DocumentId, List<SimpleNameSyntax>>();
        foreach (var location in found.SelectMany(r => r.Locations).Where(l => !l.IsImplicit))
        {
            var name = await NameAtAsync(location, ct).ConfigureAwait(false);
            if (name is not null)
            {
                if (!byDocument.TryGetValue(location.Document.Id, out var names))
                {
                    names = byDocument[location.Document.Id] = [];
                }

                names.Add(name);
            }
        }

        return byDocument;
    }

    private static async Task<SimpleNameSyntax?> NameAtAsync(
        ReferenceLocation location,
        CancellationToken ct
    )
    {
        var root = await location.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return root?.FindNode(location.Location.SourceSpan, getInnermostNodeForTie: true)
            as SimpleNameSyntax;
    }

    /// <summary>Drop the container from each qualified reference in one document.</summary>
    private static async Task<Solution> ShortenAsync(
        Solution solution,
        DocumentId documentId,
        List<SimpleNameSyntax> names,
        CancellationToken ct
    )
    {
        var document = solution.GetDocument(documentId);
        var root = document is null ? null : await document.GetSyntaxRootAsync(ct).ConfigureAwait(false);
        return root is null ? solution : solution.WithDocumentSyntaxRoot(documentId, Shorten(root, names));
    }

    private static SyntaxNode Shorten(SyntaxNode root, IEnumerable<SimpleNameSyntax> names)
    {
        var qualified = names
            .Select(name => (Name: name, Qualified: MoveTypeOutSyntax.QualifiedParent(name)))
            .Where(pair => pair.Qualified is not null)
            .ToDictionary(pair => pair.Qualified!, pair => pair.Name);
        return root.ReplaceNodes(
            qualified.Keys,
            (node, _) => MoveTypeOutSyntax.WithoutContainer(node, qualified[node])
        );
    }

    /// <summary>The declaration as it will read at namespace level.</summary>
    private static async Task<BaseTypeDeclarationSyntax> MovedDeclarationAsync(
        MoveTypeOutTarget target,
        CancellationToken ct
    )
    {
        var model = await target.Document.GetSemanticModelAsync(ct).ConfigureAwait(false);
        var qualified = model is null
            ? target.Declaration
            : MoveTypeOutSyntax.QualifyEnclosingMembers(target, model, ct);
        return MoveTypeOutSyntax.AtNamespaceLevel(qualified);
    }

    /// <summary>
    /// Take the declaration out of its container, shortening any qualified reference
    /// the same file holds, and reformat the container.
    /// </summary>
    private static async Task<Solution> RemoveFromSourceAsync(
        Solution solution,
        MoveTypeOutTarget target,
        List<SimpleNameSyntax> names,
        CancellationToken ct
    )
    {
        var document = solution.GetDocument(target.Document.Id)!;
        var root = (await document.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var outside = names.Where(name => !target.Declaration.Span.Contains(name.Span)).ToList();
        var removed = Remove(root.TrackNodes(outside.Append<SyntaxNode>(target.Declaration)), target);
        var current = outside.Select(removed.GetCurrentNode).OfType<SimpleNameSyntax>();
        var formatted = await Formatter
            .FormatAsync(
                document.WithSyntaxRoot(Shorten(removed, current)),
                Formatter.Annotation,
                cancellationToken: ct
            )
            .ConfigureAwait(false);
        return formatted.Project.Solution;
    }

    /// <summary>The root without the declaration, its container marked for formatting.</summary>
    private static SyntaxNode Remove(SyntaxNode tracked, MoveTypeOutTarget target)
    {
        var container = tracked.GetCurrentNode(target.Declaration)!.Parent!;
        tracked = tracked.ReplaceNode(
            container,
            container.WithAdditionalAnnotations(Formatter.Annotation)
        );
        return tracked.RemoveNode(
            tracked.GetCurrentNode(target.Declaration)!,
            SyntaxRemoveOptions.KeepUnbalancedDirectives | SyntaxRemoveOptions.AddElasticMarker
        )!;
    }

    /// <summary>Add the new file, formatted, as text: the client gets what a parser would produce.</summary>
    private static async Task<Solution> AddFileAsync(
        Solution solution,
        MoveTypeOutTarget target,
        BaseTypeDeclarationSyntax moved,
        CancellationToken ct
    )
    {
        var source = (await target.Document.GetSyntaxRootAsync(ct).ConfigureAwait(false))!;
        var unit = MoveTypeOutSyntax.NewCompilationUnit((CompilationUnitSyntax)source, target, moved);
        var added = solution
            .GetProject(target.Document.Project.Id)!
            .AddDocument(target.FileName, unit, target.Document.Folders, target.FilePath);
        var formatted = await Formatter.FormatAsync(added, cancellationToken: ct).ConfigureAwait(false);
        var text = await formatted.GetTextAsync(ct).ConfigureAwait(false);
        return formatted.Project.Solution.WithDocumentText(added.Id, text);
    }
}
