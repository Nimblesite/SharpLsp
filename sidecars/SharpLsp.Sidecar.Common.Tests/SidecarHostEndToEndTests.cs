using System.Net.Sockets;
using System.Text;
using MessagePack;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using ByteResult = Outcome.Result<byte[], string>;

#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — tests own temp fixtures

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Coarse end-to-end exercise of <see cref="SidecarHost" /> over a real platform
/// IPC socket. A concrete host is started, a client connects, and the full
/// request/response lifecycle is driven across the wire: built-in ping, a custom
/// success handler, a handler returning a failure, an unknown method, a handler
/// that throws, a malformed frame, a response-shaped envelope, and finally
/// shutdown. This single flow covers the host accept/dispatch loop together with
/// the <see cref="IpcConnection" /> listener, <see cref="FramedTransport" />
/// framing, <c>MessageRouter</c> dispatch, and <c>SidecarLog</c> init/shutdown.
/// </summary>
public sealed class SidecarHostEndToEndTests
{
    private sealed class TestHost : SidecarHost
    {
        public TestHost()
            : base("test")
        {
            Register(
                "echo",
                (payload, _) =>
                    Task.FromResult<ByteResult>(new ByteResult.Ok<byte[], string>(payload))
            );
            Register("boom", (_, _) => Task.FromResult(ByteResult.Failure("handler said no")));
            Register("throw", (_, _) => throw new InvalidOperationException("handler exploded"));
        }
    }

    [Fact]
    public async Task Host_serves_full_request_lifecycle_over_ipc()
    {
        var socketPath = IpcConnection.GenerateSocketPath($"host-e2e-{Guid.NewGuid():N}");
        var host = new TestHost();
        await using (host.ConfigureAwait(false))
        {
            var runTask = host.RunAsync(socketPath);

            var stream = await ConnectWithRetryAsync(socketPath).ConfigureAwait(true);
            var client = new FramedTransport(stream);
            await using (client.ConfigureAwait(false))
            {
                // Built-in ping handler returns "pong".
                var pong = await RoundTripAsync(client, Request(1, "ping")).ConfigureAwait(true);
                Assert.Null(pong.Error);
                Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

                // Custom success handler echoes its payload back.
                var echo = await RoundTripAsync(client, Request(2, "echo", [7, 8, 9]))
                    .ConfigureAwait(true);
                Assert.Null(echo.Error);
                Assert.Equal(new byte[] { 7, 8, 9 }, echo.Payload);

                // Handler returning a failure maps to an error envelope.
                var boom = await RoundTripAsync(client, Request(3, "boom")).ConfigureAwait(true);
                Assert.Equal("handler said no", boom.Error);

                // Unknown method is rejected by the router.
                var unknown = await RoundTripAsync(client, Request(4, "nope")).ConfigureAwait(true);
                Assert.Contains("Unknown method", unknown.Error!, StringComparison.Ordinal);

                // A throwing handler is caught and surfaced as an error.
                var thrown = await RoundTripAsync(client, Request(5, "throw")).ConfigureAwait(true);
                Assert.Contains("handler exploded", thrown.Error!, StringComparison.Ordinal);

                // A response-shaped envelope (id, no method) is treated as a response:
                // the host routes it to its (empty) pending table and sends nothing back.
                await client
                    .WriteFrameAsync(MessagePackSerializer.Serialize(new Envelope { Id = 6 }))
                    .ConfigureAwait(true);

                // A malformed frame fails to deserialize; the loop logs and continues.
                await client.WriteFrameAsync([0xC1]).ConfigureAwait(true);

                // Shutdown cancels the host; no response is awaited because the host
                // tears down its read loop as soon as the token is tripped.
                await client
                    .WriteFrameAsync(MessagePackSerializer.Serialize(Request(7, "shutdown")))
                    .ConfigureAwait(true);

                await runTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(true);
            }
        }
    }

    [Fact]
    public async Task Host_serves_ping_over_a_pipe_endpoint()
    {
        // GitHub #110 / [DIST-CI-WIN-TRANSPORT]: transport selection is a
        // runtime decision, so the full host lifecycle — listen, READY, accept,
        // serve — must work over a named-pipe endpoint on every platform. This
        // also drives the named-pipe client arm of IpcConnection.ConnectAsync.
        var endpoint = $@"\\.\pipe\sharplsp-t-{Guid.NewGuid().ToString("N")[..8]}";
        var host = new TestHost();
        await using (host.ConfigureAwait(false))
        {
            var runTask = host.RunAsync(endpoint);

            var stream = await ConnectWithRetryAsync(endpoint).ConfigureAwait(true);
            var client = new FramedTransport(stream);
            await using (client.ConfigureAwait(false))
            {
                var pong = await RoundTripAsync(client, Request(1, "ping")).ConfigureAwait(true);
                Assert.Null(pong.Error);
                Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

                await client
                    .WriteFrameAsync(MessagePackSerializer.Serialize(Request(2, "shutdown")))
                    .ConfigureAwait(true);
                await runTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(true);
            }
        }
    }

    [Fact]
    public async Task Host_loop_ends_when_client_disconnects()
    {
        // A client that closes its connection without sending shutdown drives the
        // read loop's end-of-stream exit: ReadFrame returns null, the loop breaks,
        // and RunAsync completes on its own.
        var socketPath = IpcConnection.GenerateSocketPath($"host-eos-{Guid.NewGuid():N}");
        var host = new TestHost();
        await using (host.ConfigureAwait(false))
        {
            var runTask = host.RunAsync(socketPath);

            var stream = await ConnectWithRetryAsync(socketPath).ConfigureAwait(true);
            var client = new FramedTransport(stream);
            var pong = await RoundTripAsync(client, Request(1, "ping")).ConfigureAwait(true);
            Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

            await client.DisposeAsync().ConfigureAwait(true);

            await runTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(true);
        }
    }

    [Fact]
    public async Task RunAsync_returns_when_listener_cannot_bind()
    {
        // Bind must fail so RunAsync logs the listener failure and returns cleanly.
        // The socket's parent path is a regular file (ENOTDIR), and the whole path
        // is kept well under the 108-char Unix limit so it is NOT relocated to a
        // bindable temp path by the socket-path shortening guard.
        var parentFile = Path.Combine(Path.GetTempPath(), $"slsp-nf-{Guid.NewGuid():N}"[..16]);
        await File.WriteAllTextAsync(parentFile, "x").ConfigureAwait(true);
        try
        {
            var badPath = Path.Combine(parentFile, "h.sock");
            var host = new TestHost();
            await using (host.ConfigureAwait(false))
            {
                await host.RunAsync(badPath)
                    .WaitAsync(TimeSpan.FromSeconds(5))
                    .ConfigureAwait(true);
            }
        }
        finally
        {
            File.Delete(parentFile);
        }
    }

    [Fact]
    public async Task Listener_failure_writes_a_fatal_line_to_stderr()
    {
        // GitHub #150 / [DIST-FAILURE-UX]: a sidecar that cannot bind its
        // endpoint must say so on stderr — which the Rust host inherits into
        // its own log — instead of dying silently with the reason visible only
        // in a temp-file log. That silence is what made #110 undiagnosable.
        // The line must preserve the exception type, not just its message.
        var parentFile = Path.Combine(Path.GetTempPath(), $"slsp-ft-{Guid.NewGuid():N}"[..16]);
        await File.WriteAllTextAsync(parentFile, "x").ConfigureAwait(true);
        using var capture = new CapturedConsoleWriter();
        var original = Console.Error;
        Console.SetError(capture);
        try
        {
            var badPath = Path.Combine(parentFile, "h.sock");
            var host = new TestHost();
            await using (host.ConfigureAwait(false))
            {
                await host.RunAsync(badPath)
                    .WaitAsync(TimeSpan.FromSeconds(5))
                    .ConfigureAwait(true);
            }

            var stderr = capture.Snapshot();
            Assert.Contains("FATAL", stderr, StringComparison.Ordinal);
            Assert.Contains("SocketException", stderr, StringComparison.Ordinal);
        }
        finally
        {
            Console.SetError(original);
            File.Delete(parentFile);
        }
    }

    [Fact]
    public async Task Persistent_message_loop_failures_terminate_the_host()
    {
        // GitHub #153: a transport that fails on every read (e.g. a pipe
        // broken mid-frame) must eventually terminate the message loop instead
        // of spinning at 100% CPU flooding the log forever. Undecodable frames
        // are the portable way to drive consecutive loop failures over a real
        // connection; a loop that never gives up never completes RunAsync.
        var socketPath = IpcConnection.GenerateSocketPath($"host-poison-{Guid.NewGuid():N}");
        var host = new TestHost();
        await using (host.ConfigureAwait(false))
        {
            var runTask = host.RunAsync(socketPath);

            var stream = await ConnectWithRetryAsync(socketPath).ConfigureAwait(true);
            var client = new FramedTransport(stream);
            await using (client.ConfigureAwait(false))
            {
                for (var i = 0; i < 32; i++)
                {
                    await client.WriteFrameAsync([0xC1]).ConfigureAwait(true);
                }

                await runTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(true);
            }
        }
    }

    [Fact]
    public async Task Ready_advertises_the_effective_bound_path_for_an_overlong_endpoint()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // Pipe names are never relocated; this is a Unix-socket concern.
        }

        // GitHub #154 / [DIST-CI-WIN-TRANSPORT]: the READY line is the host's
        // connect target, used verbatim (the Rust host has no counterpart of
        // ShortenIfNeeded). When the listener relocates an overlong Unix
        // endpoint, READY must advertise the path it actually bound, not the
        // path it was asked for — so this client connects to the advertised
        // path RAW, exactly like the Rust host does.
        var overlong = Path.Combine(
            Path.GetTempPath(),
            $"sharplsp-e2e-{new string('a', 120)}.sock"
        );
        using var capture = new CapturedConsoleWriter();
        var original = Console.Out;
        Console.SetOut(capture);
        try
        {
            var host = new TestHost();
            await using (host.ConfigureAwait(false))
            {
                var runTask = host.RunAsync(overlong);
                var readyPath = await WaitForReadyPathAsync(capture).ConfigureAwait(true);

                using var socket = new Socket(
                    AddressFamily.Unix,
                    SocketType.Stream,
                    ProtocolType.Unspecified
                );
                await socket
                    .ConnectAsync(new UnixDomainSocketEndPoint(readyPath))
                    .ConfigureAwait(true);
                var client = new FramedTransport(new NetworkStream(socket, ownsSocket: false));
                await using (client.ConfigureAwait(false))
                {
                    var pong = await RoundTripAsync(client, Request(1, "ping"))
                        .ConfigureAwait(true);
                    Assert.Null(pong.Error);
                    Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

                    await client
                        .WriteFrameAsync(MessagePackSerializer.Serialize(Request(2, "shutdown")))
                        .ConfigureAwait(true);
                    await runTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(true);
                }
            }
        }
        finally
        {
            Console.SetOut(original);
        }
    }

    private static async Task<string> WaitForReadyPathAsync(CapturedConsoleWriter capture)
    {
        for (var attempt = 0; attempt < 250; attempt++)
        {
            var ready = capture
                .Snapshot()
                .Split('\n')
                .Select(line => line.Trim())
                .FirstOrDefault(line => line.StartsWith("READY:", StringComparison.Ordinal));
            if (ready is not null)
            {
                return ready["READY:".Length..];
            }

            await Task.Delay(20).ConfigureAwait(true);
        }

        throw new InvalidOperationException("Host never printed READY");
    }

    /// <summary>
    /// Thread-safe console redirection target: the host writes READY/FATAL
    /// lines from its own tasks while the test polls <see cref="Snapshot" />.
    /// </summary>
    private sealed class CapturedConsoleWriter : TextWriter
    {
        private readonly StringBuilder _buffer = new();
        private readonly Lock _gate = new();

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            lock (_gate)
            {
                _ = _buffer.Append(value);
            }
        }

        public override void Write(string? value)
        {
            lock (_gate)
            {
                _ = _buffer.Append(value);
            }
        }

        public string Snapshot()
        {
            lock (_gate)
            {
                return _buffer.ToString();
            }
        }
    }

    private static Envelope Request(uint id, string method, byte[]? payload = null)
    {
        return new Envelope
        {
            Id = id,
            Method = method,
            Payload = payload ?? [],
        };
    }

    private static async Task<Envelope> RoundTripAsync(FramedTransport client, Envelope request)
    {
        await client.WriteFrameAsync(MessagePackSerializer.Serialize(request)).ConfigureAwait(true);
        var responseBytes = await client.ReadFrameAsync().ConfigureAwait(true);
        Assert.NotNull(responseBytes);
        return MessagePackSerializer.Deserialize<Envelope>(responseBytes);
    }

    private static async Task<Stream> ConnectWithRetryAsync(string socketPath)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var result = await IpcConnection.ConnectAsync(socketPath).ConfigureAwait(true);
            if (result is Outcome.Result<Stream, string>.Ok<Stream, string> ok)
            {
                return ok.Value;
            }

            await Task.Delay(20).ConfigureAwait(true);
        }

        throw new InvalidOperationException($"Could not connect to host at {socketPath}");
    }
}
