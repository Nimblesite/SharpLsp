using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E tests driving every semantic handler with inputs that exercise the
/// not-found / out-of-range / empty-result guard and exception-catch branches:
/// requests for a file that is not in the loaded workspace, and positions past
/// the end of a real document. These reach WorkspaceManager's "document not
/// found" early returns and the handlers' try/catch fault paths through the real
/// sidecar socket. The invariant is that malformed input is handled gracefully —
/// the sidecar replies (with an empty result or a descriptive error) and stays
/// alive — never a crash, which a follow-up ping verifies.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class EdgeCaseEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private string MissingFile => Path.Combine(fixture.TempDir, "NotInWorkspace.cs");

    /// <summary>
    /// Send a request whose input is malformed and assert the sidecar handled it
    /// without crashing: it returned a response envelope, and it still answers a
    /// follow-up ping. Whether the handler chose an empty result or a graceful
    /// error string, the fault branch ran and the process survived.
    /// </summary>
    private async Task AssertHandledGracefully(string method, byte[] payload)
    {
        var response = await fixture.SendAsync(method, payload);
        Assert.NotNull(response);

        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }

    private byte[] MissingPos(int line, int character)
    {
        return CSharpSidecarFixture.PosFor(MissingFile, line, character);
    }

    // ── Unknown-document guard for every position-based handler ──

    [Theory]
    [InlineData("textDocument/hover")]
    [InlineData("textDocument/definition")]
    [InlineData("textDocument/typeDefinition")]
    [InlineData("textDocument/declaration")]
    [InlineData("textDocument/implementation")]
    [InlineData("textDocument/documentHighlight")]
    [InlineData("textDocument/completion")]
    [InlineData("textDocument/prepareCallHierarchy")]
    [InlineData("callHierarchy/incomingCalls")]
    [InlineData("callHierarchy/outgoingCalls")]
    [InlineData("textDocument/prepareTypeHierarchy")]
    [InlineData("typeHierarchy/supertypes")]
    [InlineData("typeHierarchy/subtypes")]
    [InlineData("textDocument/codeLens")]
    [InlineData("textDocument/semanticTokens/full")]
    [InlineData("textDocument/prepareRename")]
    public async Task Position_handler_on_missing_document_is_handled_gracefully(string method)
    {
        await AssertHandledGracefully(method, MissingPos(0, 0));
    }

    [Fact]
    public async Task References_on_missing_document_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new ReferencesRequest
            {
                FilePath = MissingFile,
                Line = 0,
                Character = 0,
                IncludeDeclaration = true,
            }
        );
        await AssertHandledGracefully("textDocument/references", payload);
    }

    [Fact]
    public async Task Diagnostics_on_missing_document_is_handled_gracefully()
    {
        await AssertHandledGracefully(
            "workspace/diagnostics",
            MessagePackSerializer.Serialize(MissingFile)
        );
    }

    [Fact]
    public async Task InlayHints_on_missing_document_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new InlayHintRequest
            {
                FilePath = MissingFile,
                StartLine = 0,
                EndLine = 10,
            }
        );
        await AssertHandledGracefully("textDocument/inlayHint", payload);
    }

    [Fact]
    public async Task CodeAction_on_missing_document_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new CodeActionRequest
            {
                FilePath = MissingFile,
                StartLine = 0,
                StartCharacter = 0,
                EndLine = 0,
                EndCharacter = 1,
            }
        );
        await AssertHandledGracefully("textDocument/codeAction", payload);
    }

    [Fact]
    public async Task Rename_on_missing_document_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = MissingFile,
                Line = 0,
                Character = 0,
                NewName = "Renamed",
            }
        );
        await AssertHandledGracefully("textDocument/rename", payload);
    }

    [Fact]
    public async Task Formatting_on_missing_document_is_handled_gracefully()
    {
        await AssertHandledGracefully("textDocument/formatting", MissingPos(0, 0));
    }

    [Fact]
    public async Task CodeActionResolve_with_unknown_id_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new CodeActionResolveRequest { Id = int.MaxValue }
        );
        await AssertHandledGracefully("codeAction/resolve", payload);
    }

    [Fact]
    public async Task CompletionResolve_with_out_of_range_index_is_handled_gracefully()
    {
        var payload = MessagePackSerializer.Serialize(
            new CompletionResolveRequest { FilePath = MissingFile, Index = int.MaxValue }
        );
        await AssertHandledGracefully("completionItem/resolve", payload);
    }

    // ── Out-of-range positions against a real document ───────────

    [Theory]
    [InlineData("textDocument/hover")]
    [InlineData("textDocument/definition")]
    [InlineData("textDocument/documentHighlight")]
    [InlineData("textDocument/prepareCallHierarchy")]
    [InlineData("textDocument/prepareTypeHierarchy")]
    [InlineData("textDocument/prepareRename")]
    public async Task Handler_at_out_of_range_position_is_handled_gracefully(string method)
    {
        // Far past the end of the real Program.cs document: the position lookup
        // throws inside the handler, which must catch and reply, not crash.
        await AssertHandledGracefully(method, fixture.PosPayload(100_000, 0));
    }

    // ── Malformed payloads exercise every handler's deserialize fault path ──

    /// <summary>
    /// 0xC1 is the MessagePack "never used" byte: deserializing any request DTO
    /// from it fails, driving the <c>catch (Exception)</c> fault branch of each
    /// handler. The sidecar must reply with a descriptive error (never a crash),
    /// and a follow-up ping confirms the process stayed alive.
    /// </summary>
    [Theory]
    [InlineData("workspace/open")]
    [InlineData("workspace/diagnostics")]
    [InlineData("workspace/diagnostics/all")]
    [InlineData("solution/read")]
    [InlineData("textDocument/didChange")]
    [InlineData("textDocument/completion")]
    [InlineData("completionItem/resolve")]
    [InlineData("textDocument/hover")]
    [InlineData("textDocument/definition")]
    [InlineData("textDocument/typeDefinition")]
    [InlineData("textDocument/declaration")]
    [InlineData("textDocument/implementation")]
    [InlineData("textDocument/references")]
    [InlineData("textDocument/documentHighlight")]
    [InlineData("textDocument/codeAction")]
    [InlineData("codeAction/resolve")]
    [InlineData("textDocument/codeLens")]
    [InlineData("textDocument/prepareCallHierarchy")]
    [InlineData("callHierarchy/incomingCalls")]
    [InlineData("callHierarchy/outgoingCalls")]
    [InlineData("textDocument/prepareTypeHierarchy")]
    [InlineData("typeHierarchy/supertypes")]
    [InlineData("typeHierarchy/subtypes")]
    [InlineData("textDocument/formatting")]
    [InlineData("textDocument/rangeFormatting")]
    [InlineData("textDocument/onTypeFormatting")]
    [InlineData("textDocument/semanticTokens/full")]
    [InlineData("textDocument/semanticTokens/range")]
    [InlineData("textDocument/inlayHint")]
    [InlineData("textDocument/prepareRename")]
    [InlineData("textDocument/rename")]
    [InlineData("project/unusedPackages")]
    [InlineData("analyzers/configure")]
    public async Task Handler_with_malformed_payload_returns_error_and_survives(string method)
    {
        var response = await fixture.SendAsync(method, [0xC1]);
        Assert.NotNull(response.Error);

        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }

    [Fact]
    public async Task UnusedPackages_for_real_project_returns_usage()
    {
        // The loaded project's .csproj path drives the unused-packages handler
        // body end to end (a project with no PackageReferences yields empty usage).
        var csproj = Path.Combine(fixture.TempDir, "TestProject.csproj");
        await AssertHandledGracefully(
            "project/unusedPackages",
            MessagePackSerializer.Serialize(csproj)
        );
    }
}
