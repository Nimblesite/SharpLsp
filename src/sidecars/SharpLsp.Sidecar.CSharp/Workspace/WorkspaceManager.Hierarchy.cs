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
/// Call hierarchy and type hierarchy workspace methods.
/// </summary>
internal sealed partial class WorkspaceManager
{
    public Task<HierarchyItemResult> PrepareCallHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<HierarchyItem?>(
            filePath,
            null,
            document => CallHierarchyResolver.PrepareAsync(document, line, character, ct),
            ct
        );
    }

    public Task<CallHierarchyListResult> GetIncomingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunScopedAtAsync<CallHierarchyCallResult>(
            filePath,
            (line, character),
            CallHierarchyResolver.GetIncomingAsync,
            ct
        );
    }

    public Task<CallHierarchyListResult> GetOutgoingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync(
            filePath,
            new List<CallHierarchyCallResult>(),
            document => CallHierarchyResolver.GetOutgoingAsync(document, line, character, ct),
            ct
        );
    }

    public Task<HierarchyItemResult> PrepareTypeHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync<HierarchyItem?>(
            filePath,
            null,
            document => TypeHierarchyResolver.PrepareAsync(document, line, character, ct),
            ct
        );
    }

    public Task<TypeHierarchyListResult> GetSupertypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunDocumentQueryAsync(
            filePath,
            new List<HierarchyItem>(),
            document => TypeHierarchyResolver.GetSupertypesAsync(document, line, character, ct),
            ct
        );
    }

    public Task<TypeHierarchyListResult> GetSubtypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        return RunScopedAtAsync<HierarchyItem>(
            filePath,
            (line, character),
            TypeHierarchyResolver.GetSubtypesAsync,
            ct
        );
    }

    /// <summary>
    /// A hierarchy list at a position, searched in each project's active framework
    /// ([NETFX-PROJECTS-CSHARP]); empty when the document is not in the solution.
    /// </summary>
    private Task<Outcome.Result<List<T>, string>> RunScopedAtAsync<T>(
        string filePath,
        (int Line, int Character) at,
        Func<Document, SearchScope, int, int, CancellationToken, Task<List<T>>> query,
        CancellationToken ct
    )
    {
        return RunScopedQueryAsync(
            filePath,
            new List<T>(),
            (document, scope) => query(document, scope, at.Line, at.Character, ct),
            ct
        );
    }
}
