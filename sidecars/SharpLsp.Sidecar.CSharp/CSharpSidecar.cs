using MessagePack;
using Outcome;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Solutions;
using SharpLsp.Sidecar.CSharp.Workspace;
using ByteResult = Outcome.Result<byte[], string>;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// C# sidecar: hosts Roslyn via MSBuildWorkspace.
/// Registers handlers for workspace loading, diagnostics, completions, etc.
/// </summary>
internal sealed partial class CSharpSidecar : SidecarHost
{
    public CSharpSidecar()
        : base("csharp")
    {
        Register("workspace/open", HandleWorkspaceOpenAsync);
        Register("workspace/status", HandleWorkspaceStatusAsync);
        Register("solution/read", HandleSolutionReadAsync);
        Register("workspace/diagnostics", HandleDiagnosticsAsync);
        Register("workspace/diagnostics/all", HandleAllDiagnosticsAsync);
        Register("textDocument/didChange", HandleDidChangeAsync);
        Register("textDocument/completion", HandleCompletionAsync);
        Register("completionItem/resolve", HandleCompletionResolveAsync);
        Register("textDocument/hover", HandleHoverAsync);
        Register("textDocument/definition", HandleDefinitionAsync);
        Register("textDocument/typeDefinition", HandleTypeDefinitionAsync);
        Register("textDocument/declaration", HandleDeclarationAsync);
        Register("textDocument/implementation", HandleImplementationAsync);
        Register("textDocument/references", HandleReferencesAsync);
        Register("textDocument/documentHighlight", HandleDocumentHighlightAsync);
        Register("textDocument/codeAction", HandleCodeActionAsync);
        Register("codeAction/resolve", HandleCodeActionResolveAsync);
        Register("textDocument/codeLens", HandleCodeLensAsync);
        Register("textDocument/prepareCallHierarchy", HandlePrepareCallHierarchyAsync);
        Register("callHierarchy/incomingCalls", HandleIncomingCallsAsync);
        Register("callHierarchy/outgoingCalls", HandleOutgoingCallsAsync);
        Register("textDocument/prepareTypeHierarchy", HandlePrepareTypeHierarchyAsync);
        Register("typeHierarchy/supertypes", HandleSupertypesAsync);
        Register("typeHierarchy/subtypes", HandleSubtypesAsync);
        Register("textDocument/formatting", HandleFormattingAsync);
        Register("textDocument/rangeFormatting", HandleRangeFormattingAsync);
        Register("textDocument/onTypeFormatting", HandleOnTypeFormattingAsync);
        Register("textDocument/semanticTokens/full", HandleSemanticTokensFullAsync);
        Register("textDocument/semanticTokens/range", HandleSemanticTokensRangeAsync);
        Register("textDocument/inlayHint", HandleInlayHintAsync);
        Register("textDocument/prepareRename", HandlePrepareRenameAsync);
        Register("textDocument/rename", HandleRenameAsync);
        Register("project/unusedPackages", HandleUnusedPackagesAsync);
        Register("project/addPackage", HandleAddPackageAsync);
        Register("project/removePackage", HandleRemovePackageAsync);
        Register("analyzers/configure", HandleConfigureAnalyzersAsync);
    }

    private Task<ByteResult> HandleConfigureAnalyzersAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<AnalyzerConfigRequest>(
                payload,
                cancellationToken: ct
            );
            _workspace.ConfigureAnalyzers(request.DeadCode, request.Monorepo);
            var bytes = MessagePackSerializer.Serialize("ok", cancellationToken: ct);
            return Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(bytes));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ByteResult.Failure(ex.Message));
        }
    }

    private readonly WorkspaceManager _workspace = new();

    private async Task<ByteResult> HandleCodeActionAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<CodeActionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetCodeActionsAsync(
                    request.FilePath,
                    request.StartLine,
                    request.StartCharacter,
                    request.EndLine,
                    request.EndCharacter,
                    ct
                )
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleCodeActionResolveAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<CodeActionResolveRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .ResolveCodeActionAsync(request.Id, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleDidChangeAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<DidChangeRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .UpdateDocumentTextAsync(request.FilePath, request.NewText, ct)
                .ConfigureAwait(false);
            return AckOrFailure(result, "Update failed", ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleAllDiagnosticsAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<SolutionDiagnosticsRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetAllDiagnosticsAsync(request.ProjectFilter, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private Task<ByteResult> HandleCompletionAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetCompletionsAsync, ct);
    }

    private async Task<ByteResult> HandleCompletionResolveAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<CompletionResolveRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .ResolveCompletionAsync(request.Index, ct)
                .ConfigureAwait(false);
            var bytes = MessagePackSerializer.Serialize(result, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private Task<ByteResult> HandleDeclarationAsync(byte[] payload, CancellationToken ct)
    {
        return HandleSingleLocationRequestAsync(payload, _workspace.GetDeclarationAsync, ct);
    }

    private Task<ByteResult> HandleDefinitionAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetDefinitionAsync, ct);
    }

    private async Task<ByteResult> HandleDiagnosticsAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var filePath = MessagePackSerializer.Deserialize<string>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace.GetDiagnosticsAsync(filePath, ct).ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    // Implements [PKG-UNUSED-DETECT-CS]
    private async Task<ByteResult> HandleUnusedPackagesAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var projectPath = MessagePackSerializer.Deserialize<string>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetReferenceUsageAsync(projectPath, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private Task<ByteResult> HandleHoverAsync(byte[] payload, CancellationToken ct)
    {
        return HandleNullableRequestAsync(payload, _workspace.GetHoverAsync, ct);
    }

    private Task<ByteResult> HandleImplementationAsync(byte[] payload, CancellationToken ct)
    {
        return HandlePositionRequestAsync(payload, _workspace.GetImplementationsAsync, ct);
    }

    private async Task<ByteResult> HandleReferencesAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<ReferencesRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetReferencesAsync(
                    request.FilePath,
                    request.Line,
                    request.Character,
                    request.IncludeDeclaration,
                    ct
                )
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleDocumentHighlightAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload,
                cancellationToken: ct
            );
            var result = await _workspace
                .GetDocumentHighlightsAsync(request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private Task<ByteResult> HandleTypeDefinitionAsync(byte[] payload, CancellationToken ct)
    {
        return HandleSingleLocationRequestAsync(payload, _workspace.GetTypeDefinitionAsync, ct);
    }

    private static Task<TResult> InvokePositionRequestAsync<TResult>(
        byte[] payload,
        Func<string, int, int, CancellationToken, Task<TResult>> workspaceMethod,
        CancellationToken ct
    )
    {
        var request = MessagePackSerializer.Deserialize<PositionRequest>(
            payload,
            cancellationToken: ct
        );
        return workspaceMethod(request.FilePath, request.Line, request.Character, ct);
    }

    private static async Task<ByteResult> HandlePositionRequestAsync<T>(
        byte[] payload,
        Func<string, int, int, CancellationToken, Task<Result<T, string>>> workspaceMethod,
        CancellationToken ct
    )
    {
        try
        {
            var result = await InvokePositionRequestAsync(payload, workspaceMethod, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private static async Task<ByteResult> HandleNullableRequestAsync<T>(
        byte[] payload,
        Func<string, int, int, CancellationToken, Task<Result<T?, string>>> workspaceMethod,
        CancellationToken ct
    )
        where T : class
    {
        try
        {
            var result = await InvokePositionRequestAsync(payload, workspaceMethod, ct)
                .ConfigureAwait(false);
            if (result is not Result<T?, string>.Ok<T?, string> { Value: var value })
            {
                return ByteResult.Failure(!result ?? "Unknown error");
            }

            var bytes = MessagePackSerializer.Serialize(value, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private static async Task<ByteResult> HandleSingleLocationRequestAsync(
        byte[] payload,
        Func<
            string,
            int,
            int,
            CancellationToken,
            Task<Result<LocationResult?, string>>
        > workspaceMethod,
        CancellationToken ct
    )
    {
        try
        {
            var result = await InvokePositionRequestAsync(payload, workspaceMethod, ct)
                .ConfigureAwait(false);
            if (
                result
                is not Result<LocationResult?, string>.Ok<LocationResult?, string>
                {
                    Value: var location
                }
            )
            {
                return ByteResult.Failure(!result ?? "Unknown error");
            }

            var list = new LocationListResult();
            if (location is not null)
            {
                list.Locations.Add(location);
            }

            var bytes = MessagePackSerializer.Serialize(list, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    /// <summary>
    /// Serialize an "ok" acknowledgement, or convert an errored <paramref name="result"/> into
    /// a failure carrying its message (falling back to <paramref name="failureMessage"/>). Shared
    /// tail of the document-update and workspace-open handlers.
    /// </summary>
    private static ByteResult AckOrFailure<T>(
        Result<T, string> result,
        string failureMessage,
        CancellationToken ct
    )
    {
        return result.IsError
            ? ByteResult.Failure(!result ?? failureMessage)
            : new ByteResult.Ok<byte[], string>(
                MessagePackSerializer.Serialize("ok", cancellationToken: ct)
            );
    }

    private async Task<ByteResult> HandleWorkspaceOpenAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken: ct);
#pragma warning disable CS0618 // OpenAsync is obsolete - placeholder until workspace loading is redesigned
            var openResult = await _workspace.OpenAsync(path, ct).ConfigureAwait(false);
#pragma warning restore CS0618
            return AckOrFailure(openResult, "Open failed", ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private Task<ByteResult> HandleWorkspaceStatusAsync(byte[] payload, CancellationToken ct)
    {
        try
        {
            var status = _workspace.IsLoaded ? "loaded" : "not_loaded";
            var bytes = MessagePackSerializer.Serialize(status, cancellationToken: ct);
            return Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(bytes));
        }
        catch (Exception ex)
        {
            return Task.FromResult(ByteResult.Failure(ex.Message));
        }
    }

    private static async Task<ByteResult> HandleSolutionReadAsync(
        byte[] payload,
        CancellationToken ct
    )
    {
        try
        {
            var path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken: ct);
            var result = await SolutionFileReader.ReadAsync(path, ct).ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private static ByteResult SerializeResult<T>(Result<T, string> result, CancellationToken ct)
    {
        if (result is not Result<T, string>.Ok<T, string> { Value: var value })
        {
            return ByteResult.Failure(!result ?? "Unknown error");
        }

        try
        {
            var bytes = MessagePackSerializer.Serialize(value, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}
