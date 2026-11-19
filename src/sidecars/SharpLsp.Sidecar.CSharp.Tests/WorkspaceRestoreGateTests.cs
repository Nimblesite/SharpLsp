using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [DIAG-RESTORE] The NuGet restore gate runs BEFORE the compiler workspace exists: a project
/// whose restore fails opens nothing and says why, instead of loading a workspace whose every
/// package reference is an unresolved-type error. Repairing the project lets the same manager
/// open it. The failing package comes from an empty local feed, so the failure is offline
/// and deterministic.
/// </summary>
public sealed class WorkspaceRestoreGateTests : IDisposable
{
    private const string MissingPackage = "SharpLsp.Restore.Gate.Missing";

    private readonly string _root = NativePaths.Temp($"sharplsp-restore-gate-{Guid.NewGuid():N}");
    private readonly WorkspaceManager _manager = new();
    private string ProjectPath => NativePaths.Join(_root, "Gated.csproj");

    public void Dispose()
    {
        _manager.Dispose();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    [Fact]
    public async Task A_failed_restore_opens_no_workspace_and_says_why_and_a_repair_opens_it()
    {
        var feed = NativePaths.Join(_root, "feed");
        _ = Directory.CreateDirectory(feed);
        await File.WriteAllTextAsync(
            NativePaths.Join(_root, "nuget.config"),
            $"""
            <configuration>
              <packageSources>
                <clear />
                <add key="local" value="{feed}" />
              </packageSources>
            </configuration>
            """
        );
        await File.WriteAllTextAsync(NativePaths.Join(_root, "Gated.cs"), "class Gated { }");
        await File.WriteAllTextAsync(ProjectPath, ProjectXml(MissingPackage));

        // Interaction 1 — the restore fails, so the workspace is never created.
        var refused = await _manager.OpenAsync(ProjectPath);
        Assert.True(refused.IsError, "a project whose restore failed must not open");
        var reason = refused.Match(_ => string.Empty, error => error);
        Assert.False(string.IsNullOrWhiteSpace(reason), "the failure says why");
        Assert.Contains(MissingPackage, reason, StringComparison.Ordinal);
        Assert.False(_manager.IsLoaded, "no compiler workspace exists after a failed restore");

        // Interaction 2 — the repaired project restores and opens on the same manager.
        await File.WriteAllTextAsync(ProjectPath, ProjectXml(null));
        var opened = await _manager.OpenAsync(ProjectPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(_manager.IsLoaded, "the repaired project loads");
    }

    private static string ProjectXml(string? package)
    {
        var reference = package is null
            ? string.Empty
            : $"<ItemGroup><PackageReference Include=\"{package}\" Version=\"1.0.0\" /></ItemGroup>";
        return "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework>"
            + $"<OutputType>Library</OutputType></PropertyGroup>{reference}</Project>";
    }
}
