using Forge.Sidecar.Common.Ipc;

namespace Forge.Sidecar.Common.Tests;

public sealed class IpcConnectionTests
{
    [Fact]
    public void GenerateSocketPath_is_deterministic()
    {
        var path1 = IpcConnection.GenerateSocketPath("/home/user/project");
        var path2 = IpcConnection.GenerateSocketPath("/home/user/project");
        Assert.Equal(path1, path2);
    }

    [Fact]
    public void GenerateSocketPath_different_inputs_different_outputs()
    {
        var path1 = IpcConnection.GenerateSocketPath("/project-a");
        var path2 = IpcConnection.GenerateSocketPath("/project-b");
        Assert.NotEqual(path1, path2);
    }

    [Fact]
    public void GenerateSocketPath_under_108_chars()
    {
        var path = IpcConnection.GenerateSocketPath("/some/very/long/workspace/path/that/might/be/deep");
        Assert.True(path.Length < 108, $"Socket path too long: {path.Length} chars");
    }

    [Fact]
    public void GenerateSocketPath_contains_forge_prefix()
    {
        var path = IpcConnection.GenerateSocketPath("/workspace");
        Assert.Contains("forge-", path);
    }

    [Fact]
    public void GenerateSocketPath_ends_with_sock()
    {
        var path = IpcConnection.GenerateSocketPath("/workspace");
        Assert.EndsWith(".sock", path);
    }

    [Fact]
    public void CreateListener_valid_path_returns_ok()
    {
        var socketPath = Path.Combine(
            Path.GetTempPath(), $"forge-test-{Guid.NewGuid():N}.sock");
        try
        {
            var result = IpcConnection.CreateListener(socketPath);
            Assert.True(
                result is Outcome.Result<System.Net.Sockets.Socket, string>
                    .Ok<System.Net.Sockets.Socket, string>,
                "CreateListener must succeed for a valid temp path");
        }
        finally
        {
            if (File.Exists(socketPath))
            {
                File.Delete(socketPath);
            }
        }
    }

    [Fact]
    public async Task ConnectAsync_no_listener_returns_failure()
    {
        var socketPath = Path.Combine(
            Path.GetTempPath(), $"forge-noexist-{Guid.NewGuid():N}.sock");
        var result = await IpcConnection.ConnectAsync(socketPath);
        Assert.True(
            result is Outcome.Result<System.Net.Sockets.Socket, string>
                .Error<System.Net.Sockets.Socket, string>,
            "ConnectAsync must fail when no listener exists");
    }
}
