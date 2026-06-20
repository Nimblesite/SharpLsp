using System.Diagnostics;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath / Process banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coverage for [PKG-UNUSED-DETECT-CS]:
/// <see cref="WorkspaceManager.GetReferenceUsageAsync"/>. A real temp project
/// that references but never uses <c>Newtonsoft.Json</c> is restored and loaded
/// once (via <see cref="WorkspaceManagerPackagesFixture"/>) so Roslyn's
/// <c>GetUsedAssemblyReferences</c> classifies the package as unused. Error
/// branches (no solution loaded, project not loaded) are covered too.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerPackagesCoverageTests
    : IClassFixture<WorkspaceManagerPackagesFixture>
{
    private readonly WorkspaceManagerPackagesFixture _fixture;

    public WorkspaceManagerPackagesCoverageTests(WorkspaceManagerPackagesFixture fixture)
    {
        _fixture = fixture;
        Assert.True(_fixture.OpenError is null, _fixture.OpenError ?? "ok");
        Assert.True(_fixture.Manager.IsLoaded, "shared package workspace must be loaded");
    }

    [Fact]
    public async Task GetReferenceUsageClassifiesUnusedPackage()
    {
        var result = await _fixture.Manager.GetReferenceUsageAsync(_fixture.CsprojPath);
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));

        var usage = +result;
        Assert.False(string.IsNullOrEmpty(usage.PackagesRoot), "global packages folder resolved");
        Assert.NotEmpty(usage.AllPaths);
        // Newtonsoft.Json is referenced but never used → in All, not in Used.
        Assert.Contains(
            usage.AllPaths,
            p => p.Contains("newtonsoft.json", StringComparison.OrdinalIgnoreCase)
        );
        Assert.DoesNotContain(
            usage.UsedPaths,
            p => p.Contains("newtonsoft.json", StringComparison.OrdinalIgnoreCase)
        );
        // Used is necessarily a subset of All.
        Assert.True(usage.UsedPaths.Length <= usage.AllPaths.Length);
    }

    [Fact]
    public async Task GetReferenceUsageOnUnloadedProjectReturnsError()
    {
        // A real-looking path that no loaded project matches → "Project not loaded".
        var ghost = Path.Combine(Path.GetTempPath(), "no-such-Ghost.csproj");
        var result = await _fixture.Manager.GetReferenceUsageAsync(ghost);
        Assert.True(result.IsError);
    }

    [Fact]
    public async Task GetReferenceUsageWithoutSolutionReturnsError()
    {
        // A manager that never opened anything has no solution → "No solution loaded".
        using var fresh = new WorkspaceManager();
        var result = await fresh.GetReferenceUsageAsync(_fixture.CsprojPath);
        Assert.True(result.IsError);
    }
}

/// <summary>
/// Writes a real <c>.csproj</c> that references (but never uses)
/// <c>Newtonsoft.Json</c>, <c>dotnet restore</c>s it so the package compile
/// assembly resolves, then loads it once through
/// <see cref="WorkspaceManager.OpenAsync"/>.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit fixture lifecycle runs without a synchronization context"
)]
public sealed class WorkspaceManagerPackagesFixture : IAsyncLifetime, IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
          </PropertyGroup>
          <ItemGroup>
            <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
          </ItemGroup>
        </Project>
        """;

    // Uses only the framework — Newtonsoft.Json is referenced but never touched.
    private const string Source = """
        namespace PkgDemo;

        using System;

        public class Greeter
        {
            public string Greet(string name) => $"Hello, {name}!";

            public int Count { get; set; }
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wmp-tests-{Guid.NewGuid():N}"
    );

    private WorkspaceManager? _manager;

    internal WorkspaceManager Manager =>
        _manager ?? throw new InvalidOperationException("Fixture not initialized");

    public string CsprojPath { get; private set; } = "";

    public string? OpenError { get; private set; }

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        CsprojPath = Path.Combine(_root, "PkgDemo.csproj");
        await File.WriteAllTextAsync(CsprojPath, Csproj).ConfigureAwait(false);
        await File.WriteAllTextAsync(Path.Combine(_root, "Greeter.cs"), Source)
            .ConfigureAwait(false);

        Restore(_root);

        _manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await _manager.OpenAsync(CsprojPath).ConfigureAwait(false);
#pragma warning restore CS0618
        OpenError = openResult.Match<string?>(_ => null, err => err);
    }

    /// <summary>Run <c>dotnet restore</c> in <paramref name="workingDir"/>.</summary>
    private static void Restore(string workingDir)
    {
        var psi = new ProcessStartInfo("dotnet", "restore --verbosity quiet")
        {
            WorkingDirectory = workingDir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = new Process { StartInfo = psi };
        process.Start();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, "dotnet restore must succeed");
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager?.Dispose();
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }
}
