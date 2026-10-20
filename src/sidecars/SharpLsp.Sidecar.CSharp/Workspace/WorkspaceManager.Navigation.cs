// Navigation methods implement [DEFINITION-CSHARP].
using Microsoft.CodeAnalysis.Text;
using Serilog;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Hover;
using DefinitionResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationResult?, string>;
using HighlightsResult = Outcome.Result<
    SharpLsp.Sidecar.CSharp.DocumentHighlightListResult,
    string
>;
using HoverQueryResult = Outcome.Result<SharpLsp.Sidecar.CSharp.HoverResult?, string>;
using ImplementationsResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;
using ReferencesResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Position queries that navigate: hover, definition, type definition, declaration,
/// implementations, references and highlights, for C# documents and Razor files alike.
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>Get hover information at a position.</summary>
    public async Task<HoverQueryResult> GetHoverAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        Log.Debug("[Hover] request {File}:{Line}:{Character}", filePath, line, character);
        var csharp = await RunPositionQueryAsync<HoverResult?>(
                filePath,
                (line, character),
                null,
                target => HoverAtAsync(target, ct),
                ct
            )
            .ConfigureAwait(false);
        // Where no C# fragment answers in a Razor file, the markup name there does.
        // [RAZOR-FEATURES-HOVER]
        return
            csharp is HoverQueryResult.Ok<HoverResult?, string> { Value: null }
            && NativePaths.IsRazor(filePath)
            ? await MarkupHoverAsync(filePath, line, character, ct).ConfigureAwait(false)
            : csharp;
    }

    private static async Task<HoverResult?> HoverAtAsync(QueryTarget target, CancellationToken ct)
    {
        var text = await target.Document.GetTextAsync(ct).ConfigureAwait(false);
        // Every query target is a C# document, which always has a semantic model.
        var model =
            await target.Document.GetSemanticModelAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Hover found no semantic model");
        var position = text.Lines.GetPosition(new LinePosition(target.Line, target.Character));
        var built = CSharpHoverBuilder.Build(model, position, ct);
        // The hover's range is the token's mapped span, already in the Razor file for a
        // projection. [RAZOR-FEATURES-HOVER]
        return built is HoverQueryResult.Ok<HoverResult?, string> { Value: var hover }
            ? hover
            : throw new InvalidOperationException(!built ?? "Hover failed");
    }

    /// <summary>Go to definition at a position (returns all locations for partial types).</summary>
    public async Task<ImplementationsResult> GetDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        var csharp = await RunPositionQueryAsync(
                filePath,
                (line, character),
                new LocationListResult(),
                async target =>
                    await MapLocationsAsync(
                            await DefinitionResolver
                                .ResolveDefinitionLocationsAsync(
                                    target.Document,
                                    target.Line,
                                    target.Character,
                                    ct
                                )
                                .ConfigureAwait(false),
                            ct
                        )
                        .ConfigureAwait(false),
                ct
            )
            .ConfigureAwait(false);
        // Where no C# fragment answers in a Razor file, the markup name there does.
        // [RAZOR-FEATURES-DEFINITION]
        return
            csharp
                is ImplementationsResult.Ok<LocationListResult, string> { Value.Locations.Count: 0 }
            && NativePaths.IsRazor(filePath)
            ? await MarkupDefinitionAsync(filePath, line, character, ct).ConfigureAwait(false)
            : csharp;
    }

    /// <summary>Go to type definition at a position.</summary>
    public Task<DefinitionResult> GetTypeDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunLocationQueryAsync(
            filePath,
            (line, character),
            DefinitionResolver.ResolveTypeDefinitionAsync,
            ct
        );
    }

    /// <summary>Go to declaration (interface/base member) at a position.</summary>
    public Task<DefinitionResult> GetDeclarationAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunLocationQueryAsync(
            filePath,
            (line, character),
            DefinitionResolver.ResolveDeclarationAsync,
            ct
        );
    }

    /// <summary>Find all implementations of symbol at a position.</summary>
    public Task<ImplementationsResult> GetImplementationsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunScopedLocationQueryAsync(
            filePath,
            (line, character),
            (target, scope) =>
                ReferenceResolver.ResolveImplementationsAsync(
                    target.Document,
                    scope,
                    target.Line,
                    target.Character,
                    ct
                ),
            ct
        );
    }

    /// <summary>
    /// The references of the symbol at a position. In a solution with Razor files, a component
    /// type's include every tag that instantiates it, and a symbol named from markup takes its
    /// C# references. [RAZOR-FEATURES-REFERENCES]
    /// </summary>
    public async Task<ReferencesResult> GetReferencesAsync(
        string filePath,
        int line,
        int character,
        bool includeDeclaration,
        CancellationToken ct = default
    )
    {
        var csharp = await RunScopedLocationQueryAsync(
                filePath,
                (line, character),
                (target, scope) =>
                    ReferenceResolver.ResolveReferencesAsync(
                        target.Document,
                        scope,
                        target.Line,
                        target.Character,
                        includeDeclaration,
                        ct
                    ),
                ct
            )
            .ConfigureAwait(false);
        return
            HasRazorFiles()
            && csharp is ReferencesResult.Ok<LocationListResult, string> { Value: var found }
            ? new ReferencesResult.Ok<LocationListResult, string>(
                await WithMarkupReferencesAsync(
                        found,
                        filePath,
                        (line, character),
                        includeDeclaration,
                        ct
                    )
                    .ConfigureAwait(false)
            )
            : csharp;
    }

    /// <summary>
    /// The highlights of the symbol at a position. In a Razor file, a component type's include
    /// its start and end tag names, and a symbol named from markup takes its C# uses.
    /// [RAZOR-FEATURES-REFERENCES]
    /// </summary>
    public async Task<HighlightsResult> GetDocumentHighlightsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        var csharp = await RunPositionQueryAsync(
                filePath,
                (line, character),
                new DocumentHighlightListResult(),
                async target => new DocumentHighlightListResult
                {
                    Highlights = await ReferenceResolver
                        .ResolveDocumentHighlightsAsync(
                            target.Document,
                            (target.Line, target.Character),
                            target.AnswerPath,
                            ct
                        )
                        .ConfigureAwait(false),
                },
                ct
            )
            .ConfigureAwait(false);
        return
            NativePaths.IsRazor(filePath)
            && csharp
                is HighlightsResult.Ok<DocumentHighlightListResult, string> { Value: var found }
            ? new HighlightsResult.Ok<DocumentHighlightListResult, string>(
                await WithMarkupHighlightsAsync(found, filePath, (line, character), ct)
                    .ConfigureAwait(false)
            )
            : csharp;
    }
}
