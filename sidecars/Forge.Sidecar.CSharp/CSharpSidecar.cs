using Forge.Sidecar.Common;
using Forge.Sidecar.CSharp.Workspace;
using MessagePack;
using Outcome;

using ByteResult = Outcome.Result<byte[], string>;

namespace Forge.Sidecar.CSharp;

/// <summary>
/// C# sidecar: hosts Roslyn via MSBuildWorkspace.
/// Registers handlers for workspace loading, diagnostics, completions, etc.
/// </summary>
internal sealed class CSharpSidecar : SidecarHost
{

    public CSharpSidecar()
    {
        Register("workspace/open", HandleWorkspaceOpenAsync);
        Register("workspace/status", HandleWorkspaceStatusAsync);
        Register("workspace/diagnostics", HandleDiagnosticsAsync);
        Register("workspace/diagnostics/all", HandleAllDiagnosticsAsync);
        Register("textDocument/didChange", HandleDidChangeAsync);
        Register("textDocument/completion", HandleCompletionAsync);
        Register("textDocument/hover", HandleHoverAsync);
        Register("textDocument/definition", HandleDefinitionAsync);
        Register("textDocument/typeDefinition", HandleTypeDefinitionAsync);
        Register("textDocument/declaration", HandleDeclarationAsync);
        Register("textDocument/implementation", HandleImplementationAsync);
    }






    private readonly WorkspaceManager _workspace = new();






    private async Task<ByteResult> HandleDidChangeAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer
                .Deserialize<DidChangeRequest>(
                    payload, cancellationToken: ct);
            var result = await _workspace.UpdateDocumentTextAsync(
                request.FilePath, request.NewText, ct)
                .ConfigureAwait(false);
            return result.IsError
                ? ByteResult.Failure(!result ?? "Update failed")
                : new ByteResult.Ok<byte[], string>(
                    MessagePackSerializer.Serialize(
                        "ok", cancellationToken: ct));
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }

    private async Task<ByteResult> HandleAllDiagnosticsAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer
                .Deserialize<SolutionDiagnosticsRequest>(
                    payload, cancellationToken: ct);
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





    private async Task<ByteResult> HandleCompletionAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<CompletionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetCompletionsAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleDeclarationAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetDeclarationAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleDefinitionAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetDefinitionAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleDiagnosticsAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var filePath = MessagePackSerializer.Deserialize<string>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetDiagnosticsAsync(filePath, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleHoverAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetHoverAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleImplementationAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetImplementationsAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleTypeDefinitionAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var request = MessagePackSerializer.Deserialize<PositionRequest>(
                payload, cancellationToken: ct);
            var result = await _workspace.GetTypeDefinitionAsync(
                request.FilePath, request.Line, request.Character, ct)
                .ConfigureAwait(false);
            return SerializeResult(result, ct);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private async Task<ByteResult> HandleWorkspaceOpenAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var path = MessagePackSerializer.Deserialize<string>(
                payload, cancellationToken: ct);
#pragma warning disable CS0618 // OpenAsync is obsolete - placeholder until workspace loading is redesigned
            var openResult = await _workspace.OpenAsync(path, ct)
                .ConfigureAwait(false);
#pragma warning restore CS0618
            return openResult.IsError
                ? ByteResult.Failure(
                    !openResult ?? "Open failed")
                : new ByteResult.Ok<byte[], string>(
                    MessagePackSerializer.Serialize("ok", cancellationToken: ct));
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }




    private Task<ByteResult> HandleWorkspaceStatusAsync(
        byte[] payload,
        CancellationToken ct)
    {
        try
        {
            var status = _workspace.IsLoaded ? "loaded" : "not_loaded";
            var bytes = MessagePackSerializer.Serialize(
                status, cancellationToken: ct);
            return Task.FromResult<ByteResult>(
                new ByteResult.Ok<byte[], string>(bytes));
        }
        catch (Exception ex)
        {
            return Task.FromResult(
                ByteResult.Failure(ex.Message));
        }
    }




    private static ByteResult SerializeResult<T>(
        Result<T, string> result,
        CancellationToken ct)
    {
        if (result is not Result<T, string>.Ok<T, string> { Value: var value })
        {
            return ByteResult.Failure(
                !result ?? "Unknown error");
        }

        try
        {
            var bytes = MessagePackSerializer.Serialize(
                value, cancellationToken: ct);
            return new ByteResult.Ok<byte[], string>(bytes);
        }
        catch (Exception ex)
        {
            return ByteResult.Failure(ex.Message);
        }
    }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DidChangeRequest
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public string NewText { get; set; } = "";
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CompletionRequest
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class PositionRequest
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class CompletionItem
{
    [Key(0)] public string Label { get; set; } = "";
    [Key(1)] public string Kind { get; set; } = "";
    [Key(2)] public string? Detail { get; init; }
    [Key(3)] public string? InsertText { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class HoverResult
{
    [Key(0)] public string Contents { get; set; } = "";
    [Key(1)] public int? StartLine { get; init; }
    [Key(2)] public int? StartCharacter { get; init; }
    [Key(3)] public int? EndLine { get; init; }
    [Key(4)] public int? EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class LocationResult
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
    [Key(3)] public int EndLine { get; init; }
    [Key(4)] public int EndCharacter { get; init; }
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class LocationListResult
{
    [Key(0)] public List<LocationResult> Locations { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class SolutionDiagnosticsRequest
{
    [Key(0)] public string[] ProjectFilter { get; set; } = [];
}

[MessagePackObject(AllowPrivate = true)]
internal sealed class DiagnosticResult
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int StartLine { get; init; }
    [Key(2)] public int StartCharacter { get; init; }
    [Key(3)] public int EndLine { get; init; }
    [Key(4)] public int EndCharacter { get; init; }
    [Key(5)] public string Message { get; set; } = "";
    [Key(6)] public string Severity { get; set; } = "";
    [Key(7)] public string Code { get; set; } = "";
}
