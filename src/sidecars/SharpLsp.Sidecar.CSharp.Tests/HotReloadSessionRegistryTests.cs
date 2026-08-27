using System.Diagnostics;
using SharpLsp.Sidecar.CSharp.Debugging;

#pragma warning disable RS1035 // This end-to-end test deliberately creates and builds a real project.

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class HotReloadSessionRegistryTests : IDisposable
{
    private const string OriginalSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => 1;
        }
        """;

    private const string UpdatedSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => 2;
        }
        """;

    private const string RudeEditSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value(int input) => input + 2;
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-hot-reload-{Guid.NewGuid():N}"
    );

    [Fact]
    public async Task Emits_real_deltas_and_preserves_baseline_after_rude_edit()
    {
        _ = Directory.CreateDirectory(_root);
        var projectPath = Path.Combine(_root, "HotReloadFixture.csproj");
        var sourcePath = Path.Combine(_root, "Calculator.cs");
        await File.WriteAllTextAsync(
                projectPath,
                """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <TargetFramework>net10.0</TargetFramework>
                    <DebugType>portable</DebugType>
                    <Nullable>enable</Nullable>
                  </PropertyGroup>
                </Project>
                """
            )
            .ConfigureAwait(true);
        await File.WriteAllTextAsync(sourcePath, OriginalSource).ConfigureAwait(true);
        await BuildAsync(projectPath).ConfigureAwait(true);

        var registry = new HotReloadSessionRegistry();
        var started = await registry
            .HandleAsync(
                new HotReloadRequest { Action = "start", ProjectPath = projectPath },
                CancellationToken.None
            )
            .ConfigureAwait(true);

        Assert.Equal("started", started.Status);
        Assert.Equal("HotReloadFixture", started.AssemblyName);

        var applied = await registry
            .HandleAsync(
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = UpdatedSource,
                },
                CancellationToken.None
            )
            .ConfigureAwait(true);

        Assert.Equal("applied", applied.Status);
        var update = Assert.Single(applied.Updates);
        Assert.NotEqual(Guid.Empty, Guid.Parse(update.ModuleId));
        Assert.NotEmpty(Convert.FromBase64String(update.MetadataDelta));
        Assert.NotEmpty(Convert.FromBase64String(update.IlDelta));
        Assert.NotEmpty(Convert.FromBase64String(update.PdbDelta));
        Assert.Empty(applied.Diagnostics);

        var rejected = await registry
            .HandleAsync(
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = RudeEditSource,
                },
                CancellationToken.None
            )
            .ConfigureAwait(true);

        Assert.Equal("restartRequired", rejected.Status);
        Assert.Empty(rejected.Updates);
        Assert.Contains(
            rejected.Diagnostics,
            diagnostic => diagnostic.StartsWith("ENC0110:", StringComparison.Ordinal)
        );

        var ended = await registry
            .HandleAsync(
                new HotReloadRequest { Action = "end", SessionId = started.SessionId },
                CancellationToken.None
            )
            .ConfigureAwait(true);
        Assert.Equal("ended", ended.Status);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup: MSBuild may briefly retain an artifact on Windows.
        }
        catch (UnauthorizedAccessException)
        {
            // Best-effort cleanup: antivirus may briefly retain an artifact on Windows.
        }
    }

    private static async Task BuildAsync(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "build",
                projectPath,
                "--configuration",
                "Debug",
                "--nologo",
                "--verbosity",
                "quiet",
            },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        var output = await stdout.ConfigureAwait(false) + await stderr.ConfigureAwait(false);
        Assert.True(process.ExitCode == 0, $"Hot reload fixture build failed:\n{output}");
    }
}
