using MessagePack;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Only lazy compiler pulls are available over real IPC. [DIAG-IPC-WORKSPACE-PULL]</summary>
public sealed class DiagnosticPullProtocolTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task Bulk_route_is_absent_and_lazy_pulls_remain_available()
    {
        var payload = MessagePackSerializer.Serialize(new[] { Array.Empty<string>() });
        var response = await fixture.SendAsync("workspace/diagnostics/all", payload);
        Assert.NotNull(response.Error);
        Assert.Contains("Unknown method", response.Error, StringComparison.Ordinal);
        await AssertSourceMetadataAsync();
        await AssertSourcePullAsync();
        Assert.Equal("pong", await fixture.SendAndDeserializeAsync<string>("ping", []));
    }

    private async Task AssertSourceMetadataAsync()
    {
        var documents = await fixture
            .SendAndDeserializeAsync<DiagnosticDocument[]>("workspace/diagnostics/documents", [])
            .ConfigureAwait(false);
        var source = Assert.Single(
            documents,
            document => NativePaths.AreEqual(document.FilePath, fixture.SourceFile)
        );
        Assert.Equal("TestProject", source.ProjectName);
        Assert.True(NativePaths.IsRooted(source.ProjectPath));
    }

    private async Task AssertSourcePullAsync()
    {
        var diagnostics = await fixture
            .SendAndDeserializeAsync<DiagnosticResult[]>(
                "workspace/diagnostics",
                MessagePackSerializer.Serialize(fixture.SourceFile)
            )
            .ConfigureAwait(false);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Severity == "Error");
        Assert.All(
            diagnostics,
            diagnostic => Assert.True(NativePaths.AreEqual(fixture.SourceFile, diagnostic.FilePath))
        );
    }
}
