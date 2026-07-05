using System.Diagnostics;
using MessagePack;
using SharpLsp.Sidecar.Common.Ipc;
using SharpLsp.Sidecar.Common.Messages;
using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath / Process banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Regression for the C# sidecar dying "before READY" and looping forever when
/// the opened workspace carries a <c>global.json</c> that pins a .NET SDK which
/// is not installed (e.g. Fantomas pins <c>10.0.100</c> on a box that only has
/// <c>10.0.203</c>). MSBuildLocator resolved the SDK from the sidecar's working
/// directory via <c>hostfxr_resolve_sdk2</c>, which throws when nothing matches
/// the pin — killing the process before it can print <c>READY:</c>, which in turn
/// broke <c>solution/read</c> and the Solution Explorer even for pure-F#
/// solutions that never need Roslyn. [DIST-SDK-DISCOVERY]
///
/// This is a true end-to-end reproduction: it launches the real sidecar apphost
/// as its own process with the poisoned workspace as its working directory,
/// exactly as the Rust host does, and drives it over the real IPC socket.
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
public sealed class GlobalJsonSdkPinEndToEndTests
{
    [Fact]
    public async Task Sidecar_reaches_ready_and_serves_solution_read_when_global_json_pins_an_uninstalled_sdk()
    {
        var workspace = Path.Combine(Path.GetTempPath(), $"slsp-gj-{Guid.NewGuid():N}");
        Directory.CreateDirectory(workspace);
        try
        {
            // Pin an SDK that cannot possibly be installed. rollForward:latestPatch
            // keeps the pin inside its own (absent) feature band, so no installed
            // SDK satisfies it — the exact shape of the Fantomas failure.
            await File.WriteAllTextAsync(
                Path.Combine(workspace, "global.json"),
                """
                { "sdk": { "version": "999.999.100", "rollForward": "latestPatch" } }
                """
            );
            var projectPath = Path.Combine(workspace, "src", "App", "App.fsproj");
            Directory.CreateDirectory(Path.GetDirectoryName(projectPath)!);
            await File.WriteAllTextAsync(
                projectPath,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net10.0</TargetFramework>
                  </PropertyGroup>
                </Project>
                """
            );
            var slnxPath = Path.Combine(workspace, "Solo.slnx");
            await File.WriteAllTextAsync(
                slnxPath,
                """
                <Solution>
                  <Project Path="src/App/App.fsproj" />
                </Solution>
                """
            );

            // StartAsync throws with the captured child output if the sidecar exits
            // before printing READY — i.e. it fails loudly on the bug.
            await using var sidecar = await ExternalSidecar.StartAsync(workspace);

            // solution/read needs no MSBuild at all (it uses SolutionPersistence), so
            // it must succeed once the process survives startup.
            var model = await sidecar.SendAndDeserializeAsync<SolutionFileModel>(
                "solution/read",
                MessagePackSerializer.Serialize(slnxPath)
            );

            Assert.Equal("slnx", model.Format);
            var project = Assert.Single(model.Projects);
            Assert.Equal("src/App/App.fsproj", project.RelativePath);
        }
        finally
        {
            try
            {
                Directory.Delete(workspace, true);
            }
            catch (IOException) { }
        }
    }
}

/// <summary>
/// Launches the real C# sidecar apphost as a child process with a caller-chosen
/// working directory, mirrors the Rust host's <c>READY:</c> handshake over stdout,
/// then drives it over the IPC socket.
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
internal sealed class ExternalSidecar : IAsyncDisposable
{
    private readonly Process _process;
    private readonly string _socketPath;
    private readonly FramedTransport _transport;
    private int _nextId;

    private ExternalSidecar(Process process, string socketPath, FramedTransport transport)
    {
        _process = process;
        _socketPath = socketPath;
        _transport = transport;
    }

    public static async Task<ExternalSidecar> StartAsync(string workingDirectory)
    {
        var appHost = LocateAppHost();
        var socketPath = Path.Combine(Path.GetTempPath(), $"slsp-gj-{Guid.NewGuid():N}.sock");
        if (File.Exists(socketPath))
        {
            File.Delete(socketPath);
        }

        var startInfo = new ProcessStartInfo(appHost, socketPath)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        var process =
            Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start sidecar '{appHost}'");

        try
        {
            await WaitForReadyAsync(process);
            var transport = await ConnectAsync(socketPath);
            return new ExternalSidecar(process, socketPath, transport);
        }
        catch
        {
            TryKill(process);
            throw;
        }
    }

    /// <summary>
    /// Reads the child's stdout until it announces <c>READY:</c>, ignoring any
    /// unrelated noise. Throws — with the child's captured stderr — if the process
    /// exits (stdout EOF) or the deadline elapses first.
    /// </summary>
    private static async Task WaitForReadyAsync(Process process)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        while (true)
        {
            string? line;
            try
            {
                line = await process.StandardOutput.ReadLineAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                var err = await DrainStderrAsync(process);
                throw new InvalidOperationException(
                    $"Sidecar did not reach READY within the timeout. Stderr:\n{err}"
                );
            }

            if (line is null)
            {
                await process.WaitForExitAsync(CancellationToken.None);
                var err = await DrainStderrAsync(process);
                throw new InvalidOperationException(
                    $"Sidecar exited (code {process.ExitCode}) before READY. Stderr:\n{err}"
                );
            }

            if (line.StartsWith("READY:", StringComparison.Ordinal))
            {
                return;
            }
        }
    }

    public async Task<T> SendAndDeserializeAsync<T>(string method, byte[] payload)
    {
        var envelope = await SendAsync(method, payload);
        Assert.Null(envelope.Error);
        return MessagePackSerializer.Deserialize<T>(envelope.Payload);
    }

    private async Task<Envelope> SendAsync(string method, byte[] payload)
    {
        var id = (uint)Interlocked.Increment(ref _nextId);
        var envelope = new Envelope
        {
            Id = id,
            Method = method,
            Payload = payload,
        };
        await _transport.WriteFrameAsync(MessagePackSerializer.Serialize(envelope));
        var raw = await _transport.ReadFrameAsync();
        return raw is null
            ? throw new InvalidOperationException("Connection closed")
            : MessagePackSerializer.Deserialize<Envelope>(raw);
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            await _transport.WriteFrameAsync(
                MessagePackSerializer.Serialize(
                    new Envelope
                    {
                        Id = (uint)Interlocked.Increment(ref _nextId),
                        Method = "shutdown",
                        Payload = [],
                    }
                )
            );
        }
        catch (IOException) { }

        await _transport.DisposeAsync();
        TryKill(_process);
        _process.Dispose();

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
            var result = await IpcConnection.ConnectAsync(socketPath);
            if (result is Outcome.Result<Stream, string>.Ok<Stream, string> ok)
            {
                return new FramedTransport(ok.Value);
            }

            await Task.Delay(25);
        }

        throw new InvalidOperationException("Cannot connect to the external sidecar socket");
    }

    private static async Task<string> DrainStderrAsync(Process process)
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            return await process.StandardError.ReadToEndAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            return "(stderr unavailable)";
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
    }

    /// <summary>
    /// Finds the sidecar apphost built alongside this test assembly:
    /// <c>sidecars/SharpLsp.Sidecar.CSharp/bin/&lt;Config&gt;/&lt;tfm&gt;/</c>.
    /// </summary>
    private static string LocateAppHost()
    {
        var net = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd('/', '\\'));
        var tfm = net.Name;
        var config = net.Parent!.Name;
        var sidecarsRoot = net.Parent!.Parent!.Parent!.Parent!;
        var exeName = OperatingSystem.IsWindows()
            ? "SharpLsp.Sidecar.CSharp.exe"
            : "SharpLsp.Sidecar.CSharp";
        var appHost = Path.Combine(
            sidecarsRoot.FullName,
            "SharpLsp.Sidecar.CSharp",
            "bin",
            config,
            tfm,
            exeName
        );

        return File.Exists(appHost)
            ? appHost
            : throw new FileNotFoundException($"Sidecar apphost not found at '{appHost}'");
    }
}
