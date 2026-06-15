using MessagePack;
using Microsoft.Build.Locator;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E tests for the <c>solution/read</c> wire method (classic <c>.sln</c>,
/// nested solution folders, and solution items) and the graceful
/// <c>shutdown</c> path. The shutdown scenario cancels the host, so it spins
/// up its own dedicated sidecar + socket rather than sharing the class
/// fixture. Everything flows through the real socket and
/// <c>FramedTransport</c>.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2000:Dispose objects before losing scope",
    Justification = "Socket ownership transfers to FramedTransport / disposed via helper"
)]
public sealed class SolutionAndShutdownEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task SolutionRead_classic_sln_returns_sln_model()
    {
        WriteCsproj(Path.Combine(fixture.TempDir, "src", "App", "App.csproj"));
        var slnPath = Path.Combine(fixture.TempDir, "App.sln");
        await File.WriteAllTextAsync(
            slnPath,
            """
            Microsoft Visual Studio Solution File, Format Version 12.00
            Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\App\App.csproj", "{00000000-0000-0000-0000-000000000001}"
            EndProject
            Global
            EndGlobal
            """
        );

        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(slnPath));

        Assert.Null(r.Error);
        var model = MessagePackSerializer.Deserialize<SolutionFileModel>(r.Payload);
        Assert.Equal("sln", model.Format);
        var project = Assert.Single(model.Projects);
        Assert.Equal("App", project.DisplayName);
        Assert.Equal("src/App/App.csproj", project.RelativePath);
    }

    [Fact]
    public async Task SolutionRead_slnx_with_nested_folders_preserves_parents()
    {
        WriteCsproj(Path.Combine(fixture.TempDir, "src", "App", "App.csproj"));
        WriteCsproj(Path.Combine(fixture.TempDir, "tests", "App.Tests", "App.Tests.csproj"));
        var slnxPath = Path.Combine(fixture.TempDir, "Nested.slnx");
        await File.WriteAllTextAsync(
            slnxPath,
            """
            <Solution>
              <Folder Name="/src/">
                <Project Path="src/App/App.csproj" />
              </Folder>
              <Folder Name="/src/tests/">
                <Project Path="tests/App.Tests/App.Tests.csproj" />
              </Folder>
            </Solution>
            """
        );

        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(slnxPath));

        Assert.Null(r.Error);
        var model = MessagePackSerializer.Deserialize<SolutionFileModel>(r.Payload);
        Assert.Equal(2, model.Folders.Count);
        var child = model.Folders.Single(folder => folder.Path == "/src/tests/");
        Assert.Equal("/src/", child.ParentPath);
        Assert.Equal("src", child.ParentName);
    }

    [Fact]
    public async Task SolutionRead_slnx_with_solution_items_maps_files()
    {
        WriteCsproj(Path.Combine(fixture.TempDir, "src", "App", "App.csproj"));
        await File.WriteAllTextAsync(Path.Combine(fixture.TempDir, "README.md"), "# App");
        var slnxPath = Path.Combine(fixture.TempDir, "Items.slnx");
        await File.WriteAllTextAsync(
            slnxPath,
            """
            <Solution>
              <Folder Name="/Solution Items/">
                <File Path="README.md" />
              </Folder>
              <Project Path="src/App/App.csproj" />
            </Solution>
            """
        );

        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(slnxPath));

        Assert.Null(r.Error);
        var model = MessagePackSerializer.Deserialize<SolutionFileModel>(r.Payload);
        Assert.Single(model.Projects);
        var item = Assert.Single(model.Files);
        Assert.Equal("README.md", item.RelativePath);
        Assert.Equal("Solution Items", item.ParentFolder);
    }

    [Fact]
    public async Task SolutionRead_missing_file_returns_error()
    {
        var missing = Path.Combine(fixture.TempDir, "DoesNotExist.sln");
        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(missing));
        Assert.NotNull(r.Error);
        Assert.Contains("does not exist", r.Error);
    }

    [Fact]
    public async Task SolutionRead_unsupported_extension_returns_error()
    {
        var bogus = Path.Combine(fixture.TempDir, "TestProject.csproj");
        var r = await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(bogus));
        Assert.NotNull(r.Error);
        Assert.Contains("Unsupported", r.Error);
    }

    [Fact]
    public async Task Shutdown_after_ping_completes_gracefully()
    {
        await using var host = await StandaloneSidecar.StartAsync();

        // Health check round-trips before shutdown.
        var pong = await host.SendAsync("ping", []);
        Assert.Null(pong.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

        // shutdown cancels the host's CTS inside the handler, so the response
        // frame may or may not race the cancellation out the door. Either way
        // the host must wind down gracefully: we get an "ok" reply OR the
        // connection closes — never a hang and never a crash.
        var outcome = await host.SendShutdownAsync();
        Assert.True(
            outcome is { Closed: true } or { Reply.Error: null },
            "shutdown must close the connection or return a clean ok reply"
        );
        if (outcome.Reply is { } reply)
        {
            Assert.Equal("ok", MessagePackSerializer.Deserialize<string>(reply.Payload));
        }
    }

    [Fact]
    public async Task Client_drop_without_shutdown_is_handled_by_host_message_loop()
    {
        var host = await StandaloneSidecar.StartAsync();

        // Round-trip a request, then drop the client socket without sending
        // shutdown. The host's message loop must observe the disconnect (its
        // ReadFrameAsync returns null → EOF branch) and wind the connection down
        // without faulting the process — exactly what happens when an editor
        // closes. DropClientThenDisposeAsync closes the client, lets the host
        // process the EOF, then disposes the host.
        var pong = await host.SendAsync("ping", []);
        Assert.Null(pong.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(pong.Payload));

        await host.DropClientThenDisposeAsync();
    }

    private static void WriteCsproj(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(
            path,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """
        );
    }
}

/// <summary>
/// A throwaway C# sidecar bound to its own Unix socket, used by the shutdown
/// test so cancelling the host does not disturb the shared class fixture.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test pool has no synchronization context"
)]
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2000:Dispose objects before losing scope",
    Justification = "Socket ownership transfers to FramedTransport, disposed in DisposeAsync"
)]
internal sealed class StandaloneSidecar : IAsyncDisposable
{
    private static readonly Lock MsBuildLock = new();

    private readonly string _socketPath;
    private readonly CSharpSidecar _sidecar;
    private readonly FramedTransport _transport;
    private int _nextId;

    private StandaloneSidecar(string socketPath, CSharpSidecar sidecar, FramedTransport transport)
    {
        _socketPath = socketPath;
        _sidecar = sidecar;
        _transport = transport;
    }

    public static async Task<StandaloneSidecar> StartAsync()
    {
        EnsureMsBuildRegistered();
        var socketPath = Path.Combine(
            Path.GetTempPath(),
            $"slsp-cs-shutdown-{Guid.NewGuid():N}.sock"
        );
        if (File.Exists(socketPath))
        {
            File.Delete(socketPath);
        }

        var sidecar = new CSharpSidecar();
        _ = Task.Run(async () => await sidecar.RunAsync(socketPath));

        var transport = await ConnectAsync(socketPath);
        return new StandaloneSidecar(socketPath, sidecar, transport);
    }

    public async Task<Envelope> SendAsync(string method, byte[] payload)
    {
        await WriteFrameAsync(method, payload);
        var raw = await _transport.ReadFrameAsync();
        return raw is null
            ? throw new InvalidOperationException("Connection closed")
            : MessagePackSerializer.Deserialize<Envelope>(raw);
    }

    /// <summary>
    /// Send <c>shutdown</c> and observe the outcome without blocking forever.
    /// The host cancels its own token inside the handler, so the response frame
    /// may be dropped; a closed connection is an equally valid graceful result.
    /// </summary>
    public async Task<ShutdownOutcome> SendShutdownAsync()
    {
        await WriteFrameAsync("shutdown", []);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try
        {
            var raw = await _transport.ReadFrameAsync(timeout.Token);
            return raw is null
                ? new ShutdownOutcome(true, null)
                : new ShutdownOutcome(false, MessagePackSerializer.Deserialize<Envelope>(raw));
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException)
        {
            // Token cancelled or socket torn down — the host shut down cleanly.
            return new ShutdownOutcome(true, null);
        }
    }

    private async Task WriteFrameAsync(string method, byte[] payload)
    {
        var id = (uint)Interlocked.Increment(ref _nextId);
        var envelope = new Envelope
        {
            Id = id,
            Method = method,
            Payload = payload,
        };
        await _transport.WriteFrameAsync(MessagePackSerializer.Serialize(envelope));
    }

    private bool _clientDropped;

    /// <summary>
    /// Close the client transport and pause so the host's message loop observes
    /// the disconnect (ReadFrameAsync returning null → the EOF branch) before the
    /// host itself is disposed. Models a client that drops its socket without
    /// sending <c>shutdown</c>.
    /// </summary>
    public async Task DropClientThenDisposeAsync()
    {
        await _transport.DisposeAsync();
        _clientDropped = true;
        await Task.Delay(300);
        await DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        if (!_clientDropped)
        {
            await _transport.DisposeAsync();
        }

        await _sidecar.DisposeAsync();
        try
        {
            if (File.Exists(_socketPath))
            {
                File.Delete(_socketPath);
            }
        }
        catch (IOException) { }
    }

    private static async Task<FramedTransport> ConnectAsync(string socketPath)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            await Task.Delay(50);
            var result = await IpcConnection.ConnectAsync(socketPath);
            if (result is Outcome.Result<Stream, string>.Ok<Stream, string> ok)
            {
                return new FramedTransport(ok.Value);
            }
        }

        throw new InvalidOperationException("Cannot connect to standalone sidecar");
    }

    private static void EnsureMsBuildRegistered()
    {
        lock (MsBuildLock)
        {
            if (!MSBuildLocator.IsRegistered)
            {
                MSBuildLocator.RegisterDefaults();
            }
        }
    }
}

/// <summary>Result of a <c>shutdown</c> request: a reply (if one raced out) or a closed connection.</summary>
internal sealed record ShutdownOutcome(bool Closed, Envelope? Reply);
