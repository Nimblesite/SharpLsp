#pragma warning disable CA1515 // xunit requires public test classes
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Disposing the C# sidecar disposes its workspace. The process entry point disposes the
/// sidecar the moment its message loop ends, after a graceful shutdown too, and the
/// MSBuild workspace is what stops the out-of-process BuildHost it keeps. Left
/// undisposed, every sidecar exit left that BuildHost running with no parent.
/// [SIDECAR-SHUTDOWN-ACK]
/// </summary>
public sealed class CSharpSidecarDisposalTests
{
    [Fact]
    public async Task Disposing_the_sidecar_disposes_its_workspace_once()
    {
        var sidecar = new CSharpSidecar();
        Assert.False(sidecar.WorkspaceDisposed, "a live sidecar keeps its workspace");

        await sidecar.DisposeAsync();
        Assert.True(sidecar.WorkspaceDisposed, "disposing the sidecar releases its workspace");

        // The entry point and an error path can both dispose: the second is a no-op.
        await sidecar.DisposeAsync();
        Assert.True(sidecar.WorkspaceDisposed);
    }
}
