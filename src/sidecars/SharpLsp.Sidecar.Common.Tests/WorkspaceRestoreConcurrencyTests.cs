using System.Diagnostics;

// RS1035: this end-to-end test deliberately writes real project files for the real SDK.
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A workspace's stale projects restore side by side, bounded, never one after another,
/// and one project's failed restore neither hides nor blocks the others.
/// [PERF-PROGRESSIVE-LOAD] (GitHub #563), [DIAG-RESTORE].
/// </summary>
public sealed class WorkspaceRestoreConcurrencyTests : IDisposable
{
    /// <summary>How long each project's restore deliberately takes.</summary>
    private const int SlowSeconds = 6;

    private readonly string _root = NativePaths.Temp($"slsp-restore-par-{Guid.NewGuid():N}");

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task Stale_projects_restore_side_by_side_and_a_second_open_restores_none()
    {
        string[] projects = [Slow("A"), Slow("B")];

        var clock = Stopwatch.StartNew();
        var result = await WorkspaceRestore.EnsureProjectsAsync(projects, CancellationToken.None);
        clock.Stop();

        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        Assert.All(projects, project => Assert.Equal(1, WorkspaceRestore.RestoresOf(project)));
        Assert.All(projects, project => Assert.True(File.Exists(Assets(project)), project));
        // One after another takes at least the sum of the deliberate waits.
        Assert.True(
            clock.Elapsed < TimeSpan.FromSeconds(SlowSeconds * projects.Length),
            $"{projects.Length} {SlowSeconds}s restores took {clock.Elapsed.TotalSeconds:F1}s: they ran in series"
        );

        var again = await WorkspaceRestore.EnsureProjectsAsync(projects, CancellationToken.None);
        Assert.True(again.IsOk, "a current workspace stays restored");
        Assert.All(projects, project => Assert.Equal(1, WorkspaceRestore.RestoresOf(project)));
    }

    [Fact]
    public async Task A_failed_restore_is_reported_in_project_order_and_the_others_still_restore()
    {
        var good = Slow("Good");
        var broken = Project(
            "Broken",
            "<PackageReference Include=\"SharpLsp.No.Such.Package.Ever\" Version=\"1.0.0\" />"
        );
        var after = Slow("After");

        var result = await WorkspaceRestore.EnsureProjectsAsync(
            [good, broken, after],
            CancellationToken.None
        );

        var error = result.Match(_ => string.Empty, failure => failure);
        Assert.True(result.IsError, "a failed restore fails the workspace restore");
        Assert.Contains(broken, error, StringComparison.Ordinal);
        Assert.Contains("NU1101", error, StringComparison.Ordinal);
        Assert.True(File.Exists(Assets(good)), "the project before the failure restored");
        Assert.True(File.Exists(Assets(after)), "and the one after it was not abandoned");
        Assert.Equal(1, WorkspaceRestore.RestoresOf(after));
    }

    /// <summary>A package-free project whose restore takes <see cref="SlowSeconds"/>.</summary>
    private string Slow(string name)
    {
        var wait = $"""
            <Target Name="SlowRestore" BeforeTargets="Restore">
              <Exec Condition="'$(OS)' == 'Windows_NT'" Command="powershell -NoProfile -Command Start-Sleep {SlowSeconds}" />
              <Exec Condition="'$(OS)' != 'Windows_NT'" Command="sleep {SlowSeconds}" />
            </Target>
            """;
        return Project(name, "", wait);
    }

    private string Project(string name, string items, string targets = "")
    {
        var directory = NativePaths.Resolve(_root, name);
        _ = Directory.CreateDirectory(directory);
        var project = NativePaths.Resolve(directory, $"{name}.csproj");
        File.WriteAllText(
            project,
            "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>"
                + $"<ItemGroup>{items}</ItemGroup>{targets}</Project>"
        );
        return project;
    }

    private static string Assets(string project)
    {
        return NativePaths.Resolve(NativePaths.DirectoryOf(project), "obj", "project.assets.json");
    }
}
