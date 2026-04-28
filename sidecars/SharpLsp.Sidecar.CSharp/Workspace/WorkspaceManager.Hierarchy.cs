using CallHierarchyItemResult = Outcome.Result<SharpLsp.Sidecar.CSharp.CallHierarchyItem?, string>;
using CallHierarchyListResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CallHierarchyCallResult>,
    string
>;
using TypeHierarchyItemResult = Outcome.Result<SharpLsp.Sidecar.CSharp.TypeHierarchyItem?, string>;
using TypeHierarchyListResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.TypeHierarchyItem>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Call hierarchy and type hierarchy workspace methods.
/// </summary>
internal sealed partial class WorkspaceManager
{
    public async Task<CallHierarchyItemResult> PrepareCallHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new CallHierarchyItemResult.Ok<CallHierarchyItem?, string>(null);
            }

            var item = await CallHierarchyResolver
                .PrepareAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new CallHierarchyItemResult.Ok<CallHierarchyItem?, string>(item);
        }
        catch (Exception ex)
        {
            return CallHierarchyItemResult.Failure(ex.Message);
        }
    }

    public async Task<CallHierarchyListResult> GetIncomingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            if (_solution is null)
            {
                return new CallHierarchyListResult.Ok<List<CallHierarchyCallResult>, string>([]);
            }

            var calls = await CallHierarchyResolver
                .GetIncomingAsync(_solution, filePath, line, character, ct)
                .ConfigureAwait(false);
            return new CallHierarchyListResult.Ok<List<CallHierarchyCallResult>, string>(calls);
        }
        catch (Exception ex)
        {
            return CallHierarchyListResult.Failure(ex.Message);
        }
    }

    public async Task<CallHierarchyListResult> GetOutgoingCallsAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new CallHierarchyListResult.Ok<List<CallHierarchyCallResult>, string>([]);
            }

            var calls = await CallHierarchyResolver
                .GetOutgoingAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new CallHierarchyListResult.Ok<List<CallHierarchyCallResult>, string>(calls);
        }
        catch (Exception ex)
        {
            return CallHierarchyListResult.Failure(ex.Message);
        }
    }

    public async Task<TypeHierarchyItemResult> PrepareTypeHierarchyAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new TypeHierarchyItemResult.Ok<TypeHierarchyItem?, string>(null);
            }

            var item = await TypeHierarchyResolver
                .PrepareAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new TypeHierarchyItemResult.Ok<TypeHierarchyItem?, string>(item);
        }
        catch (Exception ex)
        {
            return TypeHierarchyItemResult.Failure(ex.Message);
        }
    }

    public async Task<TypeHierarchyListResult> GetSupertypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null)
            {
                return new TypeHierarchyListResult.Ok<List<TypeHierarchyItem>, string>([]);
            }

            var items = await TypeHierarchyResolver
                .GetSupertypesAsync(document, line, character, ct)
                .ConfigureAwait(false);
            return new TypeHierarchyListResult.Ok<List<TypeHierarchyItem>, string>(items);
        }
        catch (Exception ex)
        {
            return TypeHierarchyListResult.Failure(ex.Message);
        }
    }

    public async Task<TypeHierarchyListResult> GetSubtypesAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct = default
    )
    {
        try
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            if (document is null || _solution is null)
            {
                return new TypeHierarchyListResult.Ok<List<TypeHierarchyItem>, string>([]);
            }

            var items = await TypeHierarchyResolver
                .GetSubtypesAsync(document, _solution, line, character, ct)
                .ConfigureAwait(false);
            return new TypeHierarchyListResult.Ok<List<TypeHierarchyItem>, string>(items);
        }
        catch (Exception ex)
        {
            return TypeHierarchyListResult.Failure(ex.Message);
        }
    }
}
