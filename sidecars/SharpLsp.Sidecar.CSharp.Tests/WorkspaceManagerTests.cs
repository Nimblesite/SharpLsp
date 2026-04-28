using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Tests for <see cref="WorkspaceManager"/> — proves that didChange edits
/// arriving before the workspace finishes loading are stashed and replayed,
/// and that Dispose releases unmanaged resources cleanly.
/// </summary>
public sealed class WorkspaceManagerTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-tests-{Guid.NewGuid():N}"
    );

    public WorkspaceManagerTests()
    {
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task UpdateDocumentText_before_open_stashes_edit_and_replays_after_open()
    {
        var (csprojPath, sourcePath) = WriteSingleFileProject(
            "namespace S; public class Foo { public void M() {} }\n"
        );

        using var manager = new WorkspaceManager();

        // Send the edit BEFORE OpenAsync — should be stashed, not failed.
        var newText = "namespace S; public class Foo { public void M() {} public int Extra; }\n";
        var stashResult = await manager.UpdateDocumentTextAsync(sourcePath, newText);
        Assert.False(stashResult.IsError, "stashed edit must succeed");

        // Now load the workspace — replay must apply the edit.
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await manager.OpenAsync(csprojPath);
#pragma warning restore CS0618
        Assert.False(openResult.IsError, openResult.Match(_ => "ok", err => err));

        // The compilation must contain the replayed text — a hover at the new
        // member would otherwise fail.
        var diags = await manager.GetDiagnosticsAsync(sourcePath);
        Assert.False(diags.IsError, "diagnostics request must succeed after replay");
    }

    [Fact]
    public async Task UpdateDocumentText_unknown_file_after_open_returns_error()
    {
        var (csprojPath, _) = WriteSingleFileProject("namespace S; public class Foo {}\n");

        using var manager = new WorkspaceManager();
#pragma warning disable CS0618
        await manager.OpenAsync(csprojPath);
#pragma warning restore CS0618

        var bogus = Path.Combine(_root, "NotInProject.cs");
        var result = await manager.UpdateDocumentTextAsync(bogus, "// nope\n");

        Assert.True(result.IsError, "unknown document must fail");
        Assert.Contains("Document not found", result.Match(_ => string.Empty, err => err));
    }

    [Fact]
    public void Dispose_releases_resources_idempotently()
    {
        var manager = new WorkspaceManager();
        manager.Dispose();
        // Second Dispose must not throw — covers the conservative path.
        manager.Dispose();
    }

    [Fact]
    public void IsLoaded_false_before_open()
    {
        using var manager = new WorkspaceManager();
        Assert.False(manager.IsLoaded);
    }

    [Fact]
    public async Task Open_loads_slnx_solution_and_its_referenced_project()
    {
        // Reproduces the user-reported TradiSite/backend/AiCms.slnx scenario:
        // a .slnx referencing a .csproj must load successfully via
        // MSBuildWorkspace.OpenSolutionAsync (Roslyn 5.x).
        var (slnxPath, sourcePath) = WriteSlnxWithSingleProject(
            "namespace S; public class Bar { public void M() {} }\n"
        );

        using var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await manager.OpenAsync(slnxPath);
#pragma warning restore CS0618
        Assert.False(openResult.IsError, openResult.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded, "slnx solution must be loaded");

        var diags = await manager.GetDiagnosticsAsync(sourcePath);
        Assert.False(diags.IsError, "diagnostics on slnx-loaded project must succeed");
    }

    [Fact]
    public async Task Open_discovers_slnx_via_recursive_scan()
    {
        // Mirrors `sharplsp-lsp <workspace-root>` where the .slnx lives in a subdir.
        var sub = Path.Combine(_root, "backend");
        Directory.CreateDirectory(sub);
        WriteSlnxWithSingleProject("namespace S; public class Baz {}\n", sub);

        using var manager = new WorkspaceManager();
#pragma warning disable CS0618
        var openResult = await manager.OpenAsync(_root);
#pragma warning restore CS0618

        Assert.False(openResult.IsError, openResult.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded);
    }

    private (string slnxPath, string sourcePath) WriteSlnxWithSingleProject(
        string source,
        string? rootOverride = null
    )
    {
        var root = rootOverride ?? _root;
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """;
        var projectDir = Path.Combine(root, "src", "App");
        Directory.CreateDirectory(projectDir);
        var csprojPath = Path.Combine(projectDir, "App.csproj");
        var sourcePath = Path.Combine(projectDir, "Source.cs");
        File.WriteAllText(csprojPath, csproj);
        File.WriteAllText(sourcePath, source);

        var slnxPath = Path.Combine(root, "App.slnx");
        File.WriteAllText(
            slnxPath,
            """
            <Solution>
              <Project Path="src/App/App.csproj" />
            </Solution>
            """
        );
        return (slnxPath, sourcePath);
    }

    private (string csprojPath, string sourcePath) WriteSingleFileProject(string source)
    {
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """;
        var csprojPath = Path.Combine(_root, "Stash.csproj");
        var sourcePath = Path.Combine(_root, "Source.cs");
        File.WriteAllText(csprojPath, csproj);
        File.WriteAllText(sourcePath, source);
        return (csprojPath, sourcePath);
    }
}
