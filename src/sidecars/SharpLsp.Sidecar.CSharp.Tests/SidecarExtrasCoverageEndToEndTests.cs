using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coarse E2E tests for handler paths the broad suites leave uncovered, driven
/// through the real sidecar socket via <see cref="CSharpSidecarFixture"/>.
/// Covers successful analyzer configuration and the cross-sidecar rename
/// protocol, including malformed requests that must not poison the socket.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class SidecarExtrasCoverageEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(true, false)]
    public async Task ConfigureAnalyzers_with_valid_request_acknowledges(
        bool deadCode,
        bool monorepo
    )
    {
        var response = await fixture.SendAsync(
            "analyzers/configure",
            MessagePackSerializer.Serialize(
                new AnalyzerConfigRequest { DeadCode = deadCode, Monorepo = monorepo }
            )
        );

        Assert.Null(response.Error);
        Assert.Equal("ok", MessagePackSerializer.Deserialize<string>(response.Payload));

        // The sidecar stays healthy after reconfiguring analyzers.
        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }

    [Fact]
    public async Task Rename_identity_returns_the_source_symbol_wire_identity()
    {
        // [RENAME-PREPARE] The real socket boundary preserves the Roslyn identity.
        var identity = await fixture.SendAndDeserializeAsync<RenameIdentityResultWire>(
            "textDocument/renameIdentity",
            fixture.PosPayload(3, 13)
        );
        Assert.True(identity.Found);
        Assert.Equal("TestProject", identity.AssemblyName);
        Assert.Equal("T:TestProject.Calculator", identity.XmlDocSig);
    }

    [Fact]
    public async Task Foreign_rename_without_a_matching_assembly_returns_an_empty_edit()
    {
        // [RENAME-APPLY] A valid cross-sidecar request remains a successful no-op.
        var edit = await fixture.SendAndDeserializeAsync<RenameForeignRequest, WorkspaceEditResult>(
            "workspace/renameForeign",
            new RenameForeignRequest
            {
                AssemblyName = "ForeignAssembly",
                XmlDocSig = "T:Foreign.Widget",
                NewName = "RenamedWidget",
            }
        );
        Assert.Empty(edit.DocumentChanges);
    }

    [Theory]
    [InlineData("textDocument/renameIdentity")]
    [InlineData("workspace/renameForeign")]
    public async Task Foreign_rename_handlers_reject_malformed_payload_and_stay_healthy(
        string method
    )
    {
        var response = await fixture.SendAsync(method, [0xC1]);
        Assert.NotNull(response.Error);

        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }
}
