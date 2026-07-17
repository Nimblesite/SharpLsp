using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Resilience E2E tests: every position-driven handler is sent a wildly
/// out-of-range position against a real, loaded document. Roslyn's
/// <c>TextLineCollection.GetPosition</c> throws <c>ArgumentOutOfRangeException</c>
/// for a line past the end of the file, which each resolver's <c>try/catch</c>
/// must convert into a graceful <c>Failure</c> — never a crash that would take
/// down the sidecar (and, through inherited stderr, the host). This drives the
/// exception-handling arms of <c>WorkspaceManager</c> and the per-feature
/// resolvers that the happy-path suites never reach, and asserts the sidecar
/// keeps serving afterwards.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class SidecarBadPositionResilienceEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    // A line far past the end of the (small) fixture document. The resolver
    // finds the document, then throws mapping this position onto its text.
    private const int OutOfRangeLine = 1_000_000;

    private async Task AssertSurvivesAsync(string method, byte[] payload)
    {
        // The handler must reply (never hang) and report an error rather than
        // crash: the position maps past the document, so the resolver's catch
        // arm returns a Failure that the router surfaces as an error envelope.
        var response = await fixture.SendAsync(method, payload);
        Assert.NotNull(response.Error);

        // And the sidecar keeps serving the next request.
        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }

    [Theory]
    [InlineData("textDocument/hover")]
    [InlineData("textDocument/definition")]
    [InlineData("textDocument/typeDefinition")]
    [InlineData("textDocument/declaration")]
    [InlineData("textDocument/implementation")]
    [InlineData("textDocument/completion")]
    [InlineData("textDocument/documentHighlight")]
    [InlineData("textDocument/prepareRename")]
    [InlineData("textDocument/prepareCallHierarchy")]
    [InlineData("textDocument/prepareTypeHierarchy")]
    public async Task Position_handler_survives_out_of_range_position(string method)
    {
        await AssertSurvivesAsync(method, fixture.PosPayload(OutOfRangeLine, 0));
    }

    [Fact]
    public async Task References_survives_out_of_range_position()
    {
        var payload = MessagePackSerializer.Serialize(
            new ReferencesRequest
            {
                FilePath = fixture.SourceFile,
                Line = OutOfRangeLine,
                Character = 0,
                IncludeDeclaration = true,
            }
        );
        await AssertSurvivesAsync("textDocument/references", payload);
    }

    [Fact]
    public async Task Rename_survives_out_of_range_position()
    {
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = OutOfRangeLine,
                Character = 0,
                NewName = "Renamed",
            }
        );
        await AssertSurvivesAsync("textDocument/rename", payload);
    }

    [Fact]
    public async Task CodeAction_survives_out_of_range_range()
    {
        var payload = MessagePackSerializer.Serialize(
            new CodeActionRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = OutOfRangeLine,
                StartCharacter = 0,
                EndLine = OutOfRangeLine,
                EndCharacter = 1,
            }
        );
        await AssertSurvivesAsync("textDocument/codeAction", payload);
    }

    [Fact]
    public async Task InlayHint_survives_out_of_range_range()
    {
        var payload = MessagePackSerializer.Serialize(
            new InlayHintRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = OutOfRangeLine,
                EndLine = OutOfRangeLine + 1,
            }
        );
        await AssertSurvivesAsync("textDocument/inlayHint", payload);
    }
}
