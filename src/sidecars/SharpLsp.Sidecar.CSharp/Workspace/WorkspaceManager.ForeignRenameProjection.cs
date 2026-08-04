using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    private readonly record struct ForeignProjection(
        string CurrentName,
        string NewName,
        ForeignRenameKey MetadataIdentity
    );

    private readonly record struct ProjectionDocument(
        Document Document,
        SyntaxNode Root,
        List<SyntaxToken> Candidates,
        ForeignProjection Projection
    );

    private readonly record struct ProjectionBinding(
        ProjectionDocument Source,
        Dictionary<int, SyntaxAnnotation> Annotations,
        SyntaxNode Root,
        SemanticModel Model
    );

    private static async Task<List<ForeignReference>> CompleteForeignReferencesAsync(
        ForeignRenameRequest request,
        List<ForeignReference> references
    )
    {
        return references.Count > 0
            ? references
            : await FindProjectedForeignReferencesAsync(
                    request.Solution,
                    request.Identity,
                    request.NewName,
                    request.CancellationToken
                )
                .ConfigureAwait(false);
    }

    private static async Task<List<ForeignReference>> FindProjectedForeignReferencesAsync(
        Solution solution,
        ForeignRenameKey identity,
        string newName,
        CancellationToken ct
    )
    {
        var projection = CreateForeignProjection(identity, newName);
        return projection is null
            ? []
            : await FindVerifiedProjectedReferencesAsync(solution, projection.Value, ct)
                .ConfigureAwait(false);
    }

    private static async Task<List<ForeignReference>> FindVerifiedProjectedReferencesAsync(
        Solution solution,
        ForeignProjection projection,
        CancellationToken ct
    )
    {
        var symbols = await ResolveForeignSymbolsAsync(solution, projection.MetadataIdentity, ct)
            .ConfigureAwait(false);
        return symbols.Count == 0
            ? []
            : await FindProjectedCandidatesAsync(solution, projection, ct).ConfigureAwait(false);
    }

    private static ForeignProjection? CreateForeignProjection(
        ForeignRenameKey identity,
        string newName
    )
    {
        if (!TryFindXmlDocNameSpan(identity.XmlDocSig, out var span))
        {
            return null;
        }

        var currentName = identity.XmlDocSig.Substring(span.Start, span.Length);
        var metadataName = SyntaxFactory.ParseToken(newName).ValueText;
        var metadataXml = ReplaceXmlDocName(identity.XmlDocSig, span, metadataName);
        var metadataIdentity = new ForeignRenameKey(identity.AssemblyName, metadataXml);
        return currentName == metadataName
            ? null
            : new ForeignProjection(currentName, newName, metadataIdentity);
    }

    private static string ReplaceXmlDocName(string xmlDocSig, TextSpan span, string newName)
    {
        return xmlDocSig[..span.Start] + newName + xmlDocSig[span.End..];
    }

    private static bool TryFindXmlDocNameSpan(string xmlDocSig, out TextSpan nameSpan)
    {
        nameSpan = default;
        if (xmlDocSig.Length < 3 || xmlDocSig[1] != ':')
        {
            return false;
        }

        var end = TrimXmlDocArity(xmlDocSig, FindXmlDocHeadEnd(xmlDocSig));
        var start = end;
        while (start > 2 && SyntaxFacts.IsIdentifierPartCharacter(xmlDocSig[start - 1]))
        {
            start--;
        }

        nameSpan = TextSpan.FromBounds(start, end);
        return start < end;
    }

    private static int FindXmlDocHeadEnd(string xmlDocSig)
    {
        for (var index = 2; index < xmlDocSig.Length; index++)
        {
            if (xmlDocSig[index] is '(' or '~')
            {
                return index;
            }
        }

        return xmlDocSig.Length;
    }

    private static int TrimXmlDocArity(string xmlDocSig, int end)
    {
        var cursor = end;
        while (cursor > 2 && char.IsAsciiDigit(xmlDocSig[cursor - 1]))
        {
            cursor--;
        }

        if (cursor == end || cursor <= 2 || xmlDocSig[cursor - 1] != '`')
        {
            return end;
        }

        cursor--;
        return cursor > 2 && xmlDocSig[cursor - 1] == '`' ? cursor - 1 : cursor;
    }

    private static async Task<List<ForeignReference>> FindProjectedCandidatesAsync(
        Solution solution,
        ForeignProjection projection,
        CancellationToken ct
    )
    {
        var references = new List<ForeignReference>();
        var documents = solution.Projects.Where(IsCSharpProject).SelectMany(p => p.Documents);
        foreach (var document in documents)
        {
            references.AddRange(
                await FindProjectedDocumentReferencesAsync(document, projection, ct)
                    .ConfigureAwait(false)
            );
        }

        return DistinctReferences(references);
    }

    private static async Task<List<ForeignReference>> FindProjectedDocumentReferencesAsync(
        Document document,
        ForeignProjection projection,
        CancellationToken ct
    )
    {
        var source = await CreateProjectionDocumentAsync(document, projection, ct)
            .ConfigureAwait(false);
        return source is null
            ? []
            : await BindProjectionDocumentAsync(source.Value, ct).ConfigureAwait(false);
    }

    private static async Task<ProjectionDocument?> CreateProjectionDocumentAsync(
        Document document,
        ForeignProjection projection,
        CancellationToken ct
    )
    {
        var root =
            await document.GetSyntaxRootAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException($"Syntax root unavailable for {document.Name}");
        var candidates = ProjectableTokens(root, projection.CurrentName);
        if (candidates.Count == 0)
        {
            return null;
        }

        _ =
            document.FilePath
            ?? throw new InvalidOperationException($"Rename path unavailable for {document.Name}");
        return new ProjectionDocument(document, root, candidates, projection);
    }

    private static async Task<List<ForeignReference>> BindProjectionDocumentAsync(
        ProjectionDocument source,
        CancellationToken ct
    )
    {
        var annotations = CreateCandidateAnnotations(source.Candidates);
        var root = ProjectProjectionRoot(source, annotations);
        var projected = source.Document.WithSyntaxRoot(root);
        var model =
            await projected.GetSemanticModelAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException(
                $"Semantic model unavailable for {source.Document.Name}"
            );
        var semanticRoot = await model.SyntaxTree.GetRootAsync(ct).ConfigureAwait(false);
        var binding = new ProjectionBinding(source, annotations, semanticRoot, model);
        return BoundProjectedReferences(binding, ct);
    }

    private static SyntaxNode ProjectProjectionRoot(
        ProjectionDocument source,
        Dictionary<int, SyntaxAnnotation> annotations
    )
    {
        return ProjectTokens(
            source.Root,
            source.Candidates,
            annotations,
            source.Projection.NewName
        );
    }

    private static List<SyntaxToken> ProjectableTokens(SyntaxNode root, string currentName)
    {
        return
        [
            .. root.DescendantTokens(descendIntoTrivia: true)
                .Where(token => token.IsKind(SyntaxKind.IdentifierToken))
                .Where(token => token.ValueText.Equals(currentName, StringComparison.Ordinal)),
        ];
    }

    private static Dictionary<int, SyntaxAnnotation> CreateCandidateAnnotations(
        IEnumerable<SyntaxToken> candidates
    )
    {
        return candidates.ToDictionary(
            token => token.SpanStart,
            _ => new SyntaxAnnotation("ForeignRenameCandidate")
        );
    }

    private static SyntaxNode ProjectTokens(
        SyntaxNode root,
        IEnumerable<SyntaxToken> candidates,
        Dictionary<int, SyntaxAnnotation> annotations,
        string newName
    )
    {
        return root.ReplaceTokens(
            candidates,
            (token, _) => ProjectToken(token, newName, annotations[token.SpanStart])
        );
    }

    private static SyntaxToken ProjectToken(
        SyntaxToken token,
        string newName,
        SyntaxAnnotation annotation
    )
    {
        return SyntaxFactory
            .ParseToken(newName)
            .WithLeadingTrivia(token.LeadingTrivia)
            .WithTrailingTrivia(token.TrailingTrivia)
            .WithAdditionalAnnotations(annotation);
    }

    private static List<ForeignReference> BoundProjectedReferences(
        ProjectionBinding binding,
        CancellationToken ct
    )
    {
        var references = new List<ForeignReference>();
        foreach (var candidate in binding.Source.Candidates)
        {
            var annotation = binding.Annotations[candidate.SpanStart];
            if (ProjectedTokenMatches(binding, annotation, ct))
            {
                references.Add(MapProjectedReference(binding.Source.Document, candidate));
            }
        }

        return references;
    }

    private static ForeignReference MapProjectedReference(Document document, SyntaxToken candidate)
    {
        return new ForeignReference(document.Id, document.FilePath!, candidate.Span);
    }

    private static bool ProjectedTokenMatches(
        ProjectionBinding binding,
        SyntaxAnnotation annotation,
        CancellationToken ct
    )
    {
        var token = binding.Root.GetAnnotatedTokens(annotation).Single();
        var symbol = token.Parent is { } parent
            ? binding.Model.GetSymbolInfo(parent, ct).Symbol
            : null;
        return MatchesForeignIdentity(symbol, binding.Source.Projection.MetadataIdentity);
    }

    private static bool MatchesForeignIdentity(ISymbol? symbol, ForeignRenameKey identity)
    {
        var canonical = CanonicalForeignSymbol(symbol);
        var xmlDocSig = canonical is null
            ? null
            : DocumentationCommentId.CreateDeclarationId(canonical);
        return canonical is not null
            && MatchesAssembly(canonical, identity.AssemblyName)
            && xmlDocSig == identity.XmlDocSig;
    }

    private static ISymbol? CanonicalForeignSymbol(ISymbol? symbol)
    {
        return symbol switch
        {
            IAliasSymbol alias => alias.Target.OriginalDefinition,
            IMethodSymbol { ReducedFrom: { } reduced } => reduced.OriginalDefinition,
            null => null,
            _ => symbol.OriginalDefinition,
        };
    }
}
