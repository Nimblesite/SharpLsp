using SharpLsp.Sidecar.Common.Ipc;

namespace SharpLsp.Sidecar.Common.Tests;

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
        var path = IpcConnection.GenerateSocketPath(
            "/some/very/long/workspace/path/that/might/be/deep"
        );
        Assert.True(path.Length < 108, $"Socket path too long: {path.Length} chars");
    }

    [Fact]
    public void GenerateSocketPath_contains_sharplsp_prefix()
    {
        var path = IpcConnection.GenerateSocketPath("/workspace");
        Assert.Contains("sharplsp-", path, StringComparison.Ordinal);
    }

#if !WINDOWS
    [Fact]
    public void GenerateSocketPath_ends_with_sock()
    {
        var path = IpcConnection.GenerateSocketPath("/workspace");
        Assert.EndsWith(".sock", path, StringComparison.Ordinal);
    }
#endif

    [Fact]
    public void GenerateSocketPath_uses_platform_endpoint_shape()
    {
        var path = IpcConnection.GenerateSocketPath("/workspace");
#if WINDOWS
        Assert.StartsWith(@"\\.\pipe\sharplsp-", path, StringComparison.Ordinal);
        Assert.DoesNotContain(".sock", path, StringComparison.Ordinal);
#else
        Assert.EndsWith(".sock", path, StringComparison.Ordinal);
#endif
    }

    [Fact]
    public async Task CreateListener_valid_path_returns_ok()
    {
        var socketPath = IpcConnection.GenerateSocketPath($"listener-{Guid.NewGuid():N}");
        try
        {
            var result = IpcConnection.CreateListener(socketPath);
            var ok = Assert.IsType<
                Outcome.Result<IpcListener, string>.Ok<IpcListener, string>
            >(result);
            await ok.Value.DisposeAsync().ConfigureAwait(true);
        }
        finally
        {
            DeleteSocketFileIfPresent(socketPath);
        }
    }

    [Fact]
    public async Task ConnectAsync_round_trips_real_ipc_stream()
    {
        var socketPath = IpcConnection.GenerateSocketPath($"roundtrip-{Guid.NewGuid():N}");
        try
        {
            var listener = Assert.IsType<
                Outcome.Result<IpcListener, string>.Ok<IpcListener, string>
            >(IpcConnection.CreateListener(socketPath)).Value;

            await using var listenerLease = listener.ConfigureAwait(true);
            var acceptTask = listener.AcceptStreamAsync();
            var result = await IpcConnection.ConnectAsync(socketPath).ConfigureAwait(true);
            var client = Assert.IsType<
                Outcome.Result<Stream, string>.Ok<Stream, string>
            >(result).Value;
            await using var clientStream = client.ConfigureAwait(true);
            var server = await acceptTask.ConfigureAwait(true);
            await using var serverStream = server.ConfigureAwait(true);

            await client.WriteAsync("ping"u8.ToArray()).ConfigureAwait(true);
            var buffer = new byte[4];
            var read = await server.ReadAsync(buffer).ConfigureAwait(true);
            Assert.Equal(4, read);
            Assert.Equal("ping"u8.ToArray(), buffer);
        }
        finally
        {
            DeleteSocketFileIfPresent(socketPath);
        }
    }

    [Fact]
    public async Task ConnectAsync_no_listener_returns_failure()
    {
        var socketPath = IpcConnection.GenerateSocketPath($"noexist-{Guid.NewGuid():N}");
        var result = await IpcConnection.ConnectAsync(socketPath).ConfigureAwait(true);
        Assert.True(
            result
                is Outcome.Result<Stream, string>.Error<
                    Stream,
                    string
                >,
            "ConnectAsync must fail when no listener exists"
        );
        DeleteSocketFileIfPresent(socketPath);
    }

    private static void DeleteSocketFileIfPresent(string socketPath)
    {
        var info = new FileInfo(socketPath);
        if (info.Exists)
        {
            info.Delete();
        }
    }
}
