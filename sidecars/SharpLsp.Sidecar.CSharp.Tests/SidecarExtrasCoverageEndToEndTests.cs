using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coarse E2E tests for handler paths the broad suites leave uncovered, driven
/// through the real sidecar socket via <see cref="CSharpSidecarFixture"/>.
/// Currently: the <c>analyzers/configure</c> SUCCESS path — every other suite
/// only sends this handler malformed bytes (the error arm), so the acknowledge
/// arm (deserialize → <c>WorkspaceManager.ConfigureAnalyzers</c> → "ok") was
/// never exercised.
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
}
