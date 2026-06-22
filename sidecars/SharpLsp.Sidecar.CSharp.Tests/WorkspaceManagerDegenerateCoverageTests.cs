using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coverage for <see cref="WorkspaceManager"/> degenerate states the feature
/// suite never reaches: queries before a solution is loaded (the
/// <c>_solution is null</c> guards), an unparseable file path (the document
/// lookup's exception path), a cancelled all-diagnostics scan (the
/// cancellation rethrow), opening a directory with no project, and a pending
/// pre-load edit for a path that no document matches (dropped on replay).
/// </summary>
public sealed class WorkspaceManagerDegenerateCoverageTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-degen-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public WorkspaceManagerDegenerateCoverageTests()
    {
        Directory.CreateDirectory(_root);
        File.WriteAllText(
            Path.Combine(_root, "Degen.csproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """
        );
        _csprojPath = Path.Combine(_root, "Degen.csproj");
        _sourcePath = Path.Combine(_root, "Degen.cs");
        File.WriteAllText(_sourcePath, "namespace D;\npublic class C { public int N; }\n");
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(_csprojPath).ConfigureAwait(true);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return result.Match(value => value, _ => throw new InvalidOperationException("error"));
    }

    [Fact]
    public async Task AllDiagnostics_before_load_returns_empty()
    {
        using var manager = new WorkspaceManager();

        var result = Unwrap(await manager.GetAllDiagnosticsAsync([]));

        Assert.Empty(result);
    }

    [Fact]
    public async Task ResolveCodeAction_before_load_reports_no_solution()
    {
        using var manager = new WorkspaceManager();

        var result = await manager.ResolveCodeActionAsync(1);

        Assert.True(result.IsError);
        Assert.Contains("No solution loaded", result.Match(_ => string.Empty, err => err));
    }

    [Fact]
    public async Task IncomingCalls_before_load_returns_empty()
    {
        using var manager = new WorkspaceManager();

        Assert.Empty(Unwrap(await manager.GetIncomingCallsAsync(_sourcePath, 0, 0)));
    }

    [Fact]
    public async Task Diagnostics_before_load_returns_empty()
    {
        using var manager = new WorkspaceManager();

        // FindDocumentAsync short-circuits on the null solution.
        Assert.Empty(Unwrap(await manager.GetDiagnosticsAsync(_sourcePath)));
    }

    [Fact]
    public async Task UpdateDocumentText_before_load_is_stashed()
    {
        using var manager = new WorkspaceManager();

        var result = await manager.UpdateDocumentTextAsync(_sourcePath, "namespace D; class C {}");

        Assert.False(result.IsError, "an edit before load must be stashed, not rejected");
    }

    [Fact]
    public async Task Hover_with_unparseable_path_is_handled()
    {
        using var manager = await OpenAsync();

        // A NUL byte makes Path.GetFullPath throw inside the document lookup,
        // which is caught and treated as "document not found".
        var hover = Unwrap(await manager.GetHoverAsync("bad\0path.cs", 0, 0));

        Assert.Null(hover);
    }

    [Fact]
    public async Task AllDiagnostics_honours_cancellation()
    {
        using var manager = await OpenAsync();

        await Assert
            .ThrowsAnyAsync<OperationCanceledException>(() =>
                manager.GetAllDiagnosticsAsync([], new CancellationToken(canceled: true))
            )
            .ConfigureAwait(true);
    }

    [Fact]
    public async Task Open_on_directory_without_a_project_fails()
    {
        var emptyDir = Path.Combine(_root, "empty");
        Directory.CreateDirectory(emptyDir);
        using var manager = new WorkspaceManager();

#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var result = await manager.OpenAsync(emptyDir);
#pragma warning restore CS0618

        Assert.True(result.IsError, "opening a project-less directory must fail");
    }

    [Fact]
    public async Task Pending_edit_for_unknown_path_is_dropped_on_load()
    {
        using var manager = new WorkspaceManager();

        // Both edits arrive before load: one targets a real document (replayed),
        // the other a path no document matches (dropped during replay).
        await manager
            .UpdateDocumentTextAsync(
                _sourcePath,
                "namespace D;\npublic class C { public int N; }\n"
            )
            .ConfigureAwait(true);
        await manager
            .UpdateDocumentTextAsync(Path.Combine(_root, "ghost.cs"), "namespace D; class Ghost {}")
            .ConfigureAwait(true);

#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(_csprojPath);
#pragma warning restore CS0618

        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded);
    }
}
