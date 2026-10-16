using System.Text;
using SharpLsp.Sidecar.Common.Ipc;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>Implements [SHARPLSP-ARCHITECTURE-PATHS]: sockets fit macOS's 103-byte path limit.</summary>
public sealed class NativePathsSocketTests
{
    [Theory]
    [InlineData('x', 103, false)]
    [InlineData('x', 104, true)]
    [InlineData('x', 107, true)]
    [InlineData('é', 52, true)]
    public void SocketPathsRespectUtf8ByteLimits(char character, int count, bool relocated)
    {
        var path = new string(character, count);
        var endpoint = IpcConnection.ShortenIfNeeded(path);
        Assert.Equal(relocated, !string.Equals(path, endpoint, StringComparison.Ordinal));
        Assert.True(Encoding.UTF8.GetByteCount(endpoint) <= 103);
        Assert.Equal(endpoint, IpcConnection.ShortenIfNeeded(path));
    }
}
