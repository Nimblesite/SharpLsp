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
        return RunScopedQueryAsync(
            filePath,
            new List<CallHierarchyCallResult>(),
            (document, scope) =>
                CallHierarchyResolver.GetIncomingAsync(document, scope, line, character, ct),
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
        return RunScopedQueryAsync(
            filePath,
            new List<HierarchyItem>(),
            (document, scope) =>
                TypeHierarchyResolver.GetSubtypesAsync(document, scope, line, character, ct),
            ct
        );
    }
}
