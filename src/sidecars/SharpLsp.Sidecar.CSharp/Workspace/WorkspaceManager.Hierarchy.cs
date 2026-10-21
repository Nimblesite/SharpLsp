using Microsoft.CodeAnalysis;
using CallHierarchyListResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CallHierarchyCallResult>,
    string
>;
using HierarchyItemResult = Outcome.Result<SharpLsp.Sidecar.CSharp.HierarchyItem?, string>;
using TypeHierarchyListResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.HierarchyItem>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Call hierarchy and type hierarchy workspace methods: each runs where the position lands — a
/// C# document, or a Razor file's projection — and places what it finds in the file it belongs
/// to, dropping hidden scaffolding ([RAZOR-FEATURES-HIERARCHY]).
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>Prepare a call hierarchy item where the position lands.</summary>
    public Task<HierarchyItemResult> PrepareCallHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunItemAtAsync(filePath, (line, character), CallHierarchyResolver.PrepareAsync, ct);
    }

    /// <summary>The calls of the symbol the position lands on, from each project's active framework.</summary>
    public Task<CallHierarchyListResult> GetIncomingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunScopedRowsAtAsync<CallHierarchyCallResult>(
            filePath,
            (line, character),
            CallHierarchyResolver.GetIncomingAsync,
            ct
        );
    }

    /// <summary>The calls the symbol the position lands on makes.</summary>
    public Task<CallHierarchyListResult> GetOutgoingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunRowsAtAsync<CallHierarchyCallResult>(
            filePath,
            (line, character),
            CallHierarchyResolver.GetOutgoingAsync,
            ct
        );
    }

    /// <summary>Prepare a type hierarchy item where the position lands.</summary>
    public Task<HierarchyItemResult> PrepareTypeHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunItemAtAsync(filePath, (line, character), TypeHierarchyResolver.PrepareAsync, ct);
    }

    /// <summary>The supertypes of the type the position lands on.</summary>
    public Task<TypeHierarchyListResult> GetSupertypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunRowsAtAsync<HierarchyItem>(
            filePath,
            (line, character),
            TypeHierarchyResolver.GetSupertypesAsync,
            ct
        );
    }

    /// <summary>
    /// The subtypes of the type the position lands on, from each project's active framework
    /// ([NETFX-PROJECTS-CSHARP]).
    /// </summary>
    public Task<TypeHierarchyListResult> GetSubtypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunScopedRowsAtAsync<HierarchyItem>(
            filePath,
            (line, character),
            TypeHierarchyResolver.GetSubtypesAsync,
            ct
        );
    }

    /// <summary>The hierarchy item <paramref name="prepare"/> finds, placed in the file it belongs to.</summary>
    private Task<HierarchyItemResult> RunItemAtAsync(
        string filePath,
        (int Line, int Character) at,
        Func<Document, int, int, CancellationToken, Task<HierarchyItem?>> prepare,
        CancellationToken ct
    )
    {
        return RunPlacedAtAsync(
            filePath,
            at,
            null,
            prepare,
            (item, token) => PlaceAsync(item, token),
            ct
        );
    }

    /// <summary>The hierarchy rows <paramref name="query"/> finds, each placed in its file.</summary>
    private Task<Outcome.Result<List<T>, string>> RunRowsAtAsync<T>(
        string filePath,
        (int Line, int Character) at,
        Func<Document, int, int, CancellationToken, Task<List<T>>> query,
        CancellationToken ct
    )
        where T : HierarchyItem
    {
        return RunPlacedAtAsync(
            filePath,
            at,
            [],
            query,
            (rows, token) => PlaceAsync(rows, token),
            ct
        );
    }

    /// <summary>
    /// What <paramref name="query"/> finds where the position lands — a C# document, or a Razor
    /// file's projection — placed by <paramref name="place"/> in the file it belongs to.
    /// </summary>
    private Task<Outcome.Result<TValue, string>> RunPlacedAtAsync<TValue>(
        string filePath,
        (int Line, int Character) at,
        TValue empty,
        Func<Document, int, int, CancellationToken, Task<TValue>> query,
        Func<TValue, CancellationToken, Task<TValue>> place,
        CancellationToken ct
    )
    {
        return RunQueryAsync<QueryTarget, TValue>(
            () => ResolveHierarchyTargetAsync(filePath, at, ct),
            empty,
            async target =>
                await place(
                        await query(target.Document, target.Line, target.Character, ct)
                            .ConfigureAwait(false),
                        ct
                    )
                    .ConfigureAwait(false)
        );
    }

    /// <summary>
    /// <see cref="RunRowsAtAsync{T}"/> for a query that searches beyond the document:
    /// <paramref name="query"/> also gets each project's active framework to search.
    /// </summary>
    private Task<Outcome.Result<List<T>, string>> RunScopedRowsAtAsync<T>(
        string filePath,
        (int Line, int Character) at,
        Func<Document, SearchScope, int, int, CancellationToken, Task<List<T>>> query,
        CancellationToken ct
    )
        where T : HierarchyItem
    {
        return RunRowsAtAsync<T>(
            filePath,
            at,
            async (document, line, character, token) =>
                await query(
                        document,
                        await ScopeAsync(document, token).ConfigureAwait(false),
                        line,
                        character,
                        token
                    )
                    .ConfigureAwait(false),
            ct
        );
    }
}
