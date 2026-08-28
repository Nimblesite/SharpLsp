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
            public static int Value<T>() => 2;
        }
        """;

    private const string BrokenSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => 1 +;
        }
        """;

    private const string RecoveredSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => 3;
        }
        """;

    private const string VerifierSource = """
        using System.Reflection;
        using System.Reflection.Metadata;
        using System.IO;
        using HotReloadFixture;

        if (Calculator.Value() != 1)
        {
            return 10;
        }

        MetadataUpdater.ApplyUpdate(
            Assembly.GetExecutingAssembly(),
            File.ReadAllBytes(args[0]),
            File.ReadAllBytes(args[1]),
            File.ReadAllBytes(args[2]));
        return Calculator.Value() == 2 ? 0 : 11;
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
                    <OutputType>Exe</OutputType>
                    <DebugType>portable</DebugType>
                    <Nullable>enable</Nullable>
                  </PropertyGroup>
                </Project>
                """
            )
            .ConfigureAwait(true);
        await File.WriteAllTextAsync(sourcePath, OriginalSource).ConfigureAwait(true);
        await File.WriteAllTextAsync(Path.Combine(_root, "Program.cs"), VerifierSource)
            .ConfigureAwait(true);
        await BuildAsync(projectPath).ConfigureAwait(true);

        var registry = new HotReloadSessionRegistry();
        var started = await registry
            .HandleAsync(
                new HotReloadRequest
                {
                    Action = "start",
                    ProjectPath = projectPath,
                    Capabilities = ["Baseline", "AddDefinitionToExistingType", "NewTypeDefinition"],
                },
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
        await VerifyDeltaAsync(update).ConfigureAwait(true);

        // A save that does not compile is neither applied nor a restart demand:
        // it waits, names the compiler error, and must not corrupt the baseline.
        var waiting = await registry
            .HandleAsync(
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = BrokenSource,
                },
                CancellationToken.None
            )
            .ConfigureAwait(true);

        Assert.Equal("notCompilable", waiting.Status);
        Assert.Empty(waiting.Updates);
        Assert.Contains(
            waiting.Diagnostics,
            diagnostic => diagnostic.StartsWith("CS", StringComparison.Ordinal)
        );

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

        // Refusals must not poison the session: a compilable body edit after a
        // broken save and a rude edit still produces a real delta.
        var recovered = await registry
            .HandleAsync(
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = RecoveredSource,
                },
                CancellationToken.None
            )
            .ConfigureAwait(true);

        Assert.Equal("applied", recovered.Status);
        var recoveredUpdate = Assert.Single(recovered.Updates);
        Assert.NotEmpty(Convert.FromBase64String(recoveredUpdate.IlDelta));
        Assert.Empty(recovered.Diagnostics);

        var ended = await registry
            .HandleAsync(
                new HotReloadRequest { Action = "end", SessionId = started.SessionId },
                CancellationToken.None
            )
            .ConfigureAwait(true);
        Assert.Equal("ended", ended.Status);
    }

    private const string HelperSource = """
        namespace HotReloadFixture;

        public static class Helper
        {
            public static int Offset() => 0;
        }
        """;

    private const string HelperWithBumpSource = """
        namespace HotReloadFixture;

        public static class Helper
        {
            public static int Offset() => 0;
            public static int Bump(int value) => value + 40;
        }
        """;

    private const string CallsBumpSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => Helper.Bump(2);
        }
        """;

    private const string CallsBumpAgainSource = """
        namespace HotReloadFixture;

        public static class Calculator
        {
            public static int Value() => Helper.Bump(3);
        }
        """;

    private async Task<(
        HotReloadSessionRegistry Registry,
        string ProjectPath,
        string SourcePath
    )> StartFixtureAsync(HotReloadSessionRegistry registry)
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
                    <OutputType>Exe</OutputType>
                    <DebugType>portable</DebugType>
                    <Nullable>enable</Nullable>
                  </PropertyGroup>
                </Project>
                """
            )
            .ConfigureAwait(true);
        await File.WriteAllTextAsync(sourcePath, OriginalSource).ConfigureAwait(true);
        await File.WriteAllTextAsync(Path.Combine(_root, "Helper.cs"), HelperSource)
            .ConfigureAwait(true);
        await File.WriteAllTextAsync(
                Path.Combine(_root, "Program.cs"),
                "return HotReloadFixture.Calculator.Value();"
            )
            .ConfigureAwait(true);
        await BuildAsync(projectPath).ConfigureAwait(true);
        return (registry, projectPath, sourcePath);
    }

    private static async Task<HotReloadResponse> SendAsync(
        HotReloadSessionRegistry registry,
        HotReloadRequest request
    )
    {
        return await registry.HandleAsync(request, CancellationToken.None).ConfigureAwait(true);
    }

    // Implements [DEBUG-FEATURES-HOT-RELOAD] two-phase apply: an emitted update
    // stays pending until the debuggee's outcome commits or discards it, and a
    // discarded update leaves the Edit-and-Continue baseline untouched.
    [Fact]
    public async Task Two_phase_updates_commit_discard_and_span_documents()
    {
        var (registry, projectPath, sourcePath) = await StartFixtureAsync(
                new HotReloadSessionRegistry()
            )
            .ConfigureAwait(true);
        var started = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "start",
                    ProjectPath = projectPath,
                    Capabilities =
                    [
                        "Baseline",
                        "AddMethodToExistingType",
                        "AddStaticFieldToExistingType",
                        "AddDefinitionToExistingType",
                        "NewTypeDefinition",
                    ],
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("started", started.Status);

        // Emit, then DISCARD: the runtime never saw the delta.
        var emitted = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = UpdatedSource,
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("applied", emitted.Status);
        _ = Assert.Single(emitted.Updates);
        var discarded = await SendAsync(
                registry,
                new HotReloadRequest { Action = "discard", SessionId = started.SessionId }
            )
            .ConfigureAwait(true);
        Assert.Equal("discarded", discarded.Status);

        // A commit with nothing pending is a protocol violation, loudly.
        _ = await Assert
            .ThrowsAsync<InvalidOperationException>(async () =>
                _ = await SendAsync(
                        registry,
                        new HotReloadRequest { Action = "commit", SessionId = started.SessionId }
                    )
                    .ConfigureAwait(true)
            )
            .ConfigureAwait(true);

        // The SAME edit emits a full delta again — a broken discard would have
        // advanced the baseline and this emit would have nothing to say.
        var reEmitted = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = UpdatedSource,
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("applied", reEmitted.Status);
        var reEmittedUpdate = Assert.Single(reEmitted.Updates);
        Assert.NotEmpty(Convert.FromBase64String(reEmittedUpdate.IlDelta));
        var committed = await SendAsync(
                registry,
                new HotReloadRequest { Action = "commit", SessionId = started.SessionId }
            )
            .ConfigureAwait(true);
        Assert.Equal("committed", committed.Status);

        // A cross-file-consistent batch: the call in Calculator.cs needs the
        // method added in Helper.cs — only a single candidate spanning both
        // documents can emit it.
        var spanning = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    Documents =
                    [
                        new HotReloadDocument { FilePath = sourcePath, NewText = CallsBumpSource },
                        new HotReloadDocument
                        {
                            FilePath = Path.Combine(_root, "Helper.cs"),
                            NewText = HelperWithBumpSource,
                        },
                    ],
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("applied", spanning.Status);
        _ = Assert.Single(spanning.Updates);
        Assert.Empty(spanning.Diagnostics);
        _ = await SendAsync(
                registry,
                new HotReloadRequest { Action = "commit", SessionId = started.SessionId }
            )
            .ConfigureAwait(true);

        // The committed batch is the new baseline: a later single-file edit
        // can lean on the method Helper.cs gained.
        var leaning = await SendAsync(
                registry,
                new HotReloadRequest
                {
                    Action = "update",
                    SessionId = started.SessionId,
                    FilePath = sourcePath,
                    NewText = CallsBumpAgainSource,
                }
            )
            .ConfigureAwait(true);
        Assert.Equal("applied", leaning.Status);
        _ = Assert.Single(leaning.Updates);
        var ended = await SendAsync(
                registry,
                new HotReloadRequest { Action = "end", SessionId = started.SessionId }
            )
            .ConfigureAwait(true);
        Assert.Equal("ended", ended.Status);
    }

    // Implements [DEBUG-FEATURES-HOT-RELOAD] session hygiene: a client that
    // vanished can never leak workspaces past the registry's cap.
    [Fact]
    public async Task Capped_registry_evicts_the_oldest_session()
    {
        var (registry, projectPath, _) = await StartFixtureAsync(
                new HotReloadSessionRegistry(maxSessions: 1)
            )
            .ConfigureAwait(true);
        var first = await SendAsync(
                registry,
                new HotReloadRequest { Action = "start", ProjectPath = projectPath }
            )
            .ConfigureAwait(true);
        var second = await SendAsync(
                registry,
                new HotReloadRequest { Action = "start", ProjectPath = projectPath }
            )
            .ConfigureAwait(true);
        Assert.Equal("started", second.Status);

        var refusal = await Assert
            .ThrowsAsync<InvalidOperationException>(async () =>
                _ = await SendAsync(
                        registry,
                        new HotReloadRequest
                        {
                            Action = "update",
                            SessionId = first.SessionId,
                            FilePath = Path.Combine(_root, "Calculator.cs"),
                            NewText = UpdatedSource,
                        }
                    )
                    .ConfigureAwait(true)
            )
            .ConfigureAwait(true);
        Assert.Contains("Unknown hot reload session", refusal.Message, StringComparison.Ordinal);
        var ended = await SendAsync(
                registry,
                new HotReloadRequest { Action = "end", SessionId = second.SessionId }
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

    private async Task VerifyDeltaAsync(HotReloadDelta update)
    {
        var metadataPath = Path.Combine(_root, "update.metadata");
        var ilPath = Path.Combine(_root, "update.il");
        var pdbPath = Path.Combine(_root, "update.pdb");
        await File.WriteAllBytesAsync(metadataPath, Convert.FromBase64String(update.MetadataDelta))
            .ConfigureAwait(true);
        await File.WriteAllBytesAsync(ilPath, Convert.FromBase64String(update.IlDelta))
            .ConfigureAwait(true);
        await File.WriteAllBytesAsync(pdbPath, Convert.FromBase64String(update.PdbDelta))
            .ConfigureAwait(true);

        var assemblyPath = Path.Combine(_root, "bin", "Debug", "net10.0", "HotReloadFixture.dll");
        var startInfo = new ProcessStartInfo("dotnet")
        {
            ArgumentList = { assemblyPath, metadataPath, ilPath, pdbPath },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["DOTNET_MODIFIABLE_ASSEMBLIES"] = "debug";
        using var process = Process.Start(startInfo);
        Assert.NotNull(process);
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(CancellationToken.None).ConfigureAwait(false);
        var output = await stdout.ConfigureAwait(false) + await stderr.ConfigureAwait(false);
        Assert.True(process.ExitCode == 0, $"Runtime rejected real Roslyn deltas:\n{output}");
    }
}
