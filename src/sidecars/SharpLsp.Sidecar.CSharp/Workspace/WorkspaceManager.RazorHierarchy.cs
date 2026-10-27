using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;
using CodeLensesResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CodeLensResult>,
    string
>;
using InlayHintsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.InlayHintResult>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Inlay hints, code lenses and hierarchies answered from Razor positions: each runs on the
/// file's C# projection and puts what it finds back in the Razor text, dropping whatever lies
/// in the projection's hidden scaffolding. Implements [RAZOR-ARCHITECTURE-PROJECTION],
/// [RAZOR-FEATURES-INLAY-HINTS], [RAZOR-FEATURES-CODE-LENS] and [RAZOR-FEATURES-HIERARCHY].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// A Razor file's inlay hints for its lines <paramref name="startLine"/>..<paramref name="endLine"/>:
    /// those of the generated lines they map to, each placed back in the file.
    /// [RAZOR-FEATURES-INLAY-HINTS]
    /// </summary>
    private Task<InlayHintsResult> GetRazorInlayHintsAsync(
        string filePath,
        int startLine,
        int endLine,
        CancellationToken ct
    )
    {
        return RunQueryAsync<RazorProjection, List<InlayHintResult>>(
            () => FindRazorProjectionAsync(filePath, ct),
            [],
            async projection =>
                await HintsAsync(projection, startLine, endLine, ct).ConfigureAwait(false)
        );
    }

    private static async Task<List<InlayHintResult>> HintsAsync(
        RazorProjection projection,
        int startLine,
        int endLine,
        CancellationToken ct
    )
    {
        // A reader asking to the end of a line means to see it, but the resolver's range stops
        // at the start of the line it ends on, so the window reaches one line further.
        var hints = RazorHints.Lines(projection, startLine, endLine) is not { } lines
            ? []
            : await InlayHintResolver
                .GetHintsAsync(projection.Generated, lines.Start, lines.End + 1, ct)
                .ConfigureAwait(false);
        return RazorHints.Map(hints, projection, startLine, endLine);
    }

    /// <summary>
    /// A Razor file's code lenses: those of the members its projection declares in C# fragments,
    /// each on its Razor declaration, so its class and generated members are not lensed.
    /// [RAZOR-FEATURES-CODE-LENS]
    /// </summary>
    private Task<CodeLensesResult> GetRazorCodeLensesAsync(string filePath, CancellationToken ct)
    {
        return RunQueryAsync<RazorProjection, List<CodeLensResult>>(
            () => FindRazorProjectionAsync(filePath, ct),
            [],
            async projection =>
                await CodeLensResolver
                    .GetLensesAsync(
                        projection.Generated,
                        await ScopeAsync(projection.Generated, ct).ConfigureAwait(false),
                        ct,
                        projection.ToRazor
                    )
                    .ConfigureAwait(false)
        );
    }

    /// <summary>The locations hierarchy answers search, in each project's active framework.</summary>
    private Task<SearchScope> ScopeAsync(Document document, CancellationToken ct)
    {
        return SearchScope.OfAsync(document, _activeFrameworks, ct);
    }

    /// <summary>
    /// Where a hierarchy request at a Razor position runs: the mapped C# position, or, at the
    /// very start of the file, the component class its projection generates. The second is the
    /// inverse of the rule that lands that class at the file's start, so the follow-up a client
    /// makes from such an item — subtypes of a component, and its calls — answers from the
    /// component's own file. [RAZOR-ARCHITECTURE-PROJECTION]
    /// </summary>
    private async Task<QueryTarget?> ResolveHierarchyTargetAsync(
        string filePath,
        (int Line, int Character) at,
        CancellationToken ct
    )
    {
        return await ResolveQueryTargetAsync(filePath, at, ct).ConfigureAwait(false)
            ?? (
                NativePaths.IsRazor(filePath) && at is (0, 0)
                    ? await ComponentTargetAsync(filePath, ct).ConfigureAwait(false)
                    : null
            );
    }

    /// <summary>The component class <paramref name="razorPath"/> generates, as a query target.</summary>
    private async Task<QueryTarget?> ComponentTargetAsync(string razorPath, CancellationToken ct)
    {
        var projection = await FindRazorProjectionAsync(razorPath, ct).ConfigureAwait(false);
        var declared = projection?.FileClass;
        if (projection is null || declared is null)
        {
            return null;
        }

        var at = projection.GeneratedText.Lines.GetLinePosition(declared.Identifier.SpanStart);
        return new QueryTarget(projection.Generated, at.Line, at.Character, projection);
    }

    /// <summary>
    /// <paramref name="item"/> placed in the file it belongs to, or null when its declaration
    /// cannot be placed. A call row's sites are inside its declaration, so they are placed with
    /// it: within a C# fragment they already carry their Razor range, and a row that cannot be
    /// placed takes its sites with it. [RAZOR-FEATURES-HIERARCHY]
    /// </summary>
    private async Task<T?> PlaceAsync<T>(T? item, CancellationToken ct)
        where T : HierarchyItem
    {
        if (item is null)
        {
            return null;
        }

        var declaration = DeclarationOf(item);
        if (await MapLocationAsync(declaration, ct).ConfigureAwait(false) is { } mapped)
        {
            return Place(item, mapped);
        }

        var file = await FileMemberAsync(declaration, ct).ConfigureAwait(false);
        return file is null
            ? null
            : Place(AsFile(item, file), new LocationResult { FilePath = file });
    }

    /// <summary>
    /// The Razor file whose projection declares <paramref name="declaration"/> in its own
    /// generated class, its own members included; null for a location in no projection, or in
    /// the scaffolding of one outside that class, which has nothing in the file to point at. A
    /// component is its file, so the class and its members are the file's C#, and a call made from
    /// them names the file as its caller ([RAZOR-ARCHITECTURE-PROJECTION]).
    /// </summary>
    private async Task<string?> FileMemberAsync(LocationResult declaration, CancellationToken ct)
    {
        var projection = _solution is null
            ? null
            : await RazorLocations
                .FindProjectionAsync(_solution, declaration.FilePath, ct)
                .ConfigureAwait(false);
        return projection is not null && Owns(projection, declaration)
            ? projection.RazorPath
            : null;
    }

    /// <summary>
    /// A generated member's item as the component it belongs to: named by its Razor file and a
    /// class, because a follow-up at the file's start runs on the component class
    /// ([RAZOR-FEATURES-HIERARCHY]), never on a member the file does not show.
    /// </summary>
    private static T AsFile<T>(T item, string razorPath)
        where T : HierarchyItem
    {
        item.Name = NativePaths.NameOf(razorPath);
        item.Kind = "Class";
        return item;
    }

    /// <summary>Whether the file's own generated class holds <paramref name="declaration"/>.</summary>
    private static bool Owns(RazorProjection projection, LocationResult declaration)
    {
        var at = new LinePosition(declaration.Line, declaration.Character);
        return DocumentText.TryOffset(projection.GeneratedText, at) is { } offset
            && projection.FileClass is { } own
            && projection.GeneratedRoot.FindToken(offset).Parent?.AncestorsAndSelf().Contains(own)
                == true;
    }

    /// <summary><paramref name="items"/> placed in their files, hidden scaffolding dropped.</summary>
    private async Task<List<T>> PlaceAsync<T>(List<T> items, CancellationToken ct)
        where T : HierarchyItem
    {
        var placed = new List<T>();
        foreach (var item in items)
        {
            if (await PlaceAsync(item, ct).ConfigureAwait(false) is { } found)
            {
                placed.Add(found);
            }
        }

        return placed;
    }

    private static LocationResult DeclarationOf(HierarchyItem item)
    {
        return new LocationResult
        {
            FilePath = item.FilePath,
            Line = item.Line,
            Character = item.Character,
            EndLine = item.EndLine,
            EndCharacter = item.EndCharacter,
        };
    }

    private static T Place<T>(T item, LocationResult place)
        where T : HierarchyItem
    {
        item.FilePath = place.FilePath;
        item.Line = place.Line;
        item.Character = place.Character;
        item.EndLine = place.EndLine;
        item.EndCharacter = place.EndCharacter;
        return item;
    }
}
