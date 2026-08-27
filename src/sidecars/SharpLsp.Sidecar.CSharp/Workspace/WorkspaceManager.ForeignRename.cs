// Implements [RENAME-CROSSLANGUAGE].
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using RenameEditResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;
using RenameIdentityQueryResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.RenameIdentityResultWire,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    private readonly record struct ForeignRenameKey(string AssemblyName, string XmlDocSig);

    private readonly record struct ForeignRenameRequest(
        Solution Solution,
        ForeignRenameKey Identity,
        string NewName,
        CancellationToken CancellationToken
    );

    private readonly record struct ForeignReference(
        DocumentId DocumentId,
        string FilePath,
        TextSpan Span
    );

    public async Task<RenameIdentityQueryResult> GetRenameIdentityAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var identity = await ResolveRenameIdentityAsync(filePath, line, character, ct)
                .ConfigureAwait(false);
            return new RenameIdentityQueryResult.Ok<RenameIdentityResultWire, string>(identity);
        }
        catch (Exception ex)
        {
            return RenameIdentityQueryResult.Failure(ex.Message);
        }
    }

    private async Task<RenameIdentityResultWire> ResolveRenameIdentityAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
        if (document is null)
        {
            return new RenameIdentityResultWire();
        }

        var target = await FindRenameTargetAsync(document, line, character, ct)
            .ConfigureAwait(false);
        return CreateRenameIdentity(target?.Symbol);
    }

    private static RenameIdentityResultWire CreateRenameIdentity(ISymbol? symbol)
    {
        var assemblyName = symbol?.ContainingAssembly?.Name;
        var xmlDocSig = symbol is null ? null : DocumentationCommentId.CreateDeclarationId(symbol);
        return string.IsNullOrEmpty(assemblyName) || string.IsNullOrEmpty(xmlDocSig)
            ? new RenameIdentityResultWire()
            : new RenameIdentityResultWire
            {
                Found = true,
                AssemblyName = assemblyName,
                XmlDocSig = xmlDocSig,
            };
    }

    public async Task<RenameEditResult> RenameForeignAsync(
        string assemblyName,
        string xmlDocSig,
        string newName,
        CancellationToken ct = default
    )
    {
        try
        {
            return await RenameForeignCoreAsync(assemblyName, xmlDocSig, newName, ct)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return RenameEditResult.Failure(ex.Message);
        }
    }

    private async Task<RenameEditResult> RenameForeignCoreAsync(
        string assemblyName,
        string xmlDocSig,
        string newName,
        CancellationToken ct
    )
    {
        var solution = _solution;
        if (solution is null || !IsForeignRequestValid(assemblyName, xmlDocSig, newName))
        {
            return ForeignRenameSuccess([]);
        }

        var request = CreateForeignRenameRequest(solution, assemblyName, xmlDocSig, newName, ct);
        return await RenameLoadedForeignAsync(request).ConfigureAwait(false);
    }

    private static ForeignRenameRequest CreateForeignRenameRequest(
        Solution solution,
        string assemblyName,
        string xmlDocSig,
        string newName,
        CancellationToken ct
    )
    {
        return new ForeignRenameRequest(
            solution,
            new ForeignRenameKey(assemblyName, xmlDocSig),
            newName,
            ct
        );
    }

    private static async Task<RenameEditResult> RenameLoadedForeignAsync(
        ForeignRenameRequest request
    )
    {
        var references = await FindCurrentForeignReferencesAsync(request).ConfigureAwait(false);
        references = await CompleteForeignReferencesAsync(request, references)
            .ConfigureAwait(false);
        var edits = await BuildForeignEditsAsync(
                request.Solution,
                references,
                request.NewName,
                request.CancellationToken
            )
            .ConfigureAwait(false);
        return ForeignRenameSuccess(edits);
    }

    private static bool IsForeignRequestValid(string assemblyName, string xmlDocSig, string newName)
    {
        return !string.IsNullOrWhiteSpace(assemblyName)
            && !string.IsNullOrWhiteSpace(xmlDocSig)
            && IsValidIdentifier(newName);
    }

    private static async Task<List<ForeignReference>> FindCurrentForeignReferencesAsync(
        ForeignRenameRequest request
    )
    {
        var symbols = await ResolveForeignSymbolsAsync(
                request.Solution,
                request.Identity,
                request.CancellationToken
            )
            .ConfigureAwait(false);
        return await FindForeignReferencesAsync(
                request.Solution,
                symbols,
                request.CancellationToken
            )
            .ConfigureAwait(false);
    }

    private static async Task<List<ISymbol>> ResolveForeignSymbolsAsync(
        Solution solution,
        ForeignRenameKey identity,
        CancellationToken ct
    )
    {
        var symbols = new List<ISymbol>();
        foreach (var project in solution.Projects.Where(IsCSharpProject))
        {
            var compilation =
                await project.GetCompilationAsync(ct).ConfigureAwait(false)
                ?? throw new InvalidOperationException(
                    $"Compilation unavailable for {project.Name}"
                );
            AddMatchingSymbols(symbols, compilation, identity);
        }

        return symbols;
    }

    private static void AddMatchingSymbols(
        List<ISymbol> symbols,
        Compilation compilation,
        ForeignRenameKey identity
    )
    {
        var resolved = DocumentationCommentId.GetSymbolsForDeclarationId(
            identity.XmlDocSig,
            compilation
        );
        symbols.AddRange(resolved.Where(symbol => MatchesAssembly(symbol, identity.AssemblyName)));
    }

    private static bool IsCSharpProject(Project project)
    {
        return project.Language == LanguageNames.CSharp;
    }

    private static bool MatchesAssembly(ISymbol symbol, string assemblyName)
    {
        return string.Equals(
            symbol.ContainingAssembly?.Name,
            assemblyName,
            StringComparison.Ordinal
        );
    }

    private static async Task<List<ForeignReference>> FindForeignReferencesAsync(
        Solution solution,
        IEnumerable<ISymbol> symbols,
        CancellationToken ct
    )
    {
        var references = new List<ForeignReference>();
        foreach (var symbol in symbols)
        {
            var found = await SymbolFinder
                .FindReferencesAsync(symbol, solution, ct)
                .ConfigureAwait(false);
            AddForeignReferences(references, found);
        }

        return DistinctReferences(references);
    }

    private static void AddForeignReferences(
        List<ForeignReference> references,
        IEnumerable<ReferencedSymbol> found
    )
    {
        foreach (var referencedSymbol in found)
        {
            references.AddRange(
                referencedSymbol.Locations.Where(IsEditableReference).Select(MapReference)
            );
        }
    }

    private static bool IsEditableReference(ReferenceLocation location)
    {
        return location.Location.IsInSource
            && location.Location.SourceSpan.Length > 0
            && location.Document.FilePath is not null
            && IsCSharpProject(location.Document.Project);
    }

    private static ForeignReference MapReference(ReferenceLocation location)
    {
        return new ForeignReference(
            location.Document.Id,
            location.Document.FilePath!,
            location.Location.SourceSpan
        );
    }

    private static List<ForeignReference> DistinctReferences(
        IEnumerable<ForeignReference> references
    )
    {
        return
        [
            .. references.DistinctBy(item => (item.DocumentId, item.Span.Start, item.Span.Length)),
        ];
    }

    private static async Task<List<DocumentEditResult>> BuildForeignEditsAsync(
        Solution solution,
        IEnumerable<ForeignReference> references,
        string newName,
        CancellationToken ct
    )
    {
        var edits = new List<DocumentEditResult>();
        foreach (var group in references.GroupBy(item => item.DocumentId))
        {
            var edit = await BuildForeignDocumentEditAsync(solution, group, newName, ct)
                .ConfigureAwait(false);
            if (edit is not null)
            {
                edits.Add(edit);
            }
        }

        return [.. edits.OrderBy(edit => edit.FilePath, StringComparer.OrdinalIgnoreCase)];
    }

    private static async Task<DocumentEditResult?> BuildForeignDocumentEditAsync(
        Solution solution,
        IEnumerable<ForeignReference> references,
        string newName,
        CancellationToken ct
    )
    {
        var ordered = references.OrderBy(item => item.Span.Start).ToList();
        var first = ordered.First();
        var document =
            solution.GetDocument(first.DocumentId)
            ?? throw new InvalidOperationException(
                $"Rename document unavailable: {first.FilePath}"
            );

        var text = await document.GetTextAsync(ct).ConfigureAwait(false);
        var edits = ordered.Select(item => MapForeignEdit(text, item.Span, newName)).ToList();
        return new DocumentEditResult { FilePath = first.FilePath, Edits = edits };
    }

    private static TextEditResult MapForeignEdit(SourceText text, TextSpan span, string newName)
    {
        return DocumentText.ToTextEdit(text, new TextChange(span, newName));
    }

    private static RenameEditResult ForeignRenameSuccess(List<DocumentEditResult> edits)
    {
        var workspaceEdit = new WorkspaceEditResult { DocumentChanges = edits };
        return new RenameEditResult.Ok<WorkspaceEditResult, string>(workspaceEdit);
    }
}
