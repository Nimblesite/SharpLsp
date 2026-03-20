using Forge.Sidecar.Common;
using Forge.Sidecar.CSharp.Workspace;
using MessagePack;

namespace Forge.Sidecar.CSharp;

/// <summary>
/// C# sidecar: hosts Roslyn via MSBuildWorkspace.
/// Registers handlers for workspace loading, diagnostics, completions, etc.
/// </summary>
public sealed class CSharpSidecar : SidecarHost
{
    private readonly WorkspaceManager _workspace = new();

    public CSharpSidecar()
    {
        Register("workspace/open", HandleWorkspaceOpenAsync);
        Register("workspace/status", HandleWorkspaceStatusAsync);
        Register("workspace/diagnostics", HandleDiagnosticsAsync);
        Register("textDocument/completion", HandleCompletionAsync);
        Register("textDocument/hover", HandleHoverAsync);
        Register("textDocument/definition", HandleDefinitionAsync);
    }

    private async Task<byte[]> HandleWorkspaceOpenAsync(
        byte[] payload,
        CancellationToken ct)
    {
        var path = MessagePackSerializer.Deserialize<string>(payload, cancellationToken: ct);
        await _workspace.OpenAsync(path, ct).ConfigureAwait(false);
        return MessagePackSerializer.Serialize("ok", cancellationToken: ct);
    }

    private Task<byte[]> HandleWorkspaceStatusAsync(byte[] payload, CancellationToken ct)
    {
        var status = _workspace.IsLoaded ? "loaded" : "not_loaded";
        return Task.FromResult(MessagePackSerializer.Serialize(status, cancellationToken: ct));
    }

    private async Task<byte[]> HandleDiagnosticsAsync(byte[] payload, CancellationToken ct)
    {
        var filePath = MessagePackSerializer.Deserialize<string>(payload, cancellationToken: ct);
        var diagnostics = await _workspace.GetDiagnosticsAsync(filePath, ct)
            .ConfigureAwait(false);
        return MessagePackSerializer.Serialize(diagnostics, cancellationToken: ct);
    }

    private async Task<byte[]> HandleCompletionAsync(byte[] payload, CancellationToken ct)
    {
        var request = MessagePackSerializer.Deserialize<CompletionRequest>(
            payload, cancellationToken: ct);
        var items = await _workspace.GetCompletionsAsync(
            request.FilePath, request.Line, request.Character, ct)
            .ConfigureAwait(false);
        return MessagePackSerializer.Serialize(items, cancellationToken: ct);
    }

    private async Task<byte[]> HandleHoverAsync(byte[] payload, CancellationToken ct)
    {
        var request = MessagePackSerializer.Deserialize<PositionRequest>(
            payload, cancellationToken: ct);
        var hover = await _workspace.GetHoverAsync(
            request.FilePath, request.Line, request.Character, ct)
            .ConfigureAwait(false);
        return MessagePackSerializer.Serialize(hover, cancellationToken: ct);
    }

    private async Task<byte[]> HandleDefinitionAsync(byte[] payload, CancellationToken ct)
    {
        var request = MessagePackSerializer.Deserialize<PositionRequest>(
            payload, cancellationToken: ct);
        var location = await _workspace.GetDefinitionAsync(
            request.FilePath, request.Line, request.Character, ct)
            .ConfigureAwait(false);
        return MessagePackSerializer.Serialize(location, cancellationToken: ct);
    }
}

[MessagePackObject]
public sealed class CompletionRequest
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
}

[MessagePackObject]
public sealed class PositionRequest
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
}

[MessagePackObject]
public sealed class CompletionItem
{
    [Key(0)] public string Label { get; set; } = "";
    [Key(1)] public string Kind { get; set; } = "";
    [Key(2)] public string? Detail { get; init; }
    [Key(3)] public string? InsertText { get; init; }
}

[MessagePackObject]
public sealed class HoverResult
{
    [Key(0)] public string Contents { get; set; } = "";
}

[MessagePackObject]
public sealed class LocationResult
{
    [Key(0)] public string FilePath { get; set; } = "";
    [Key(1)] public int Line { get; init; }
    [Key(2)] public int Character { get; init; }
}

[MessagePackObject]
public sealed class DiagnosticResult
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
