using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: these tests deliberately touch the real
// filesystem — the repo mandates testing against real files, not mocks.
#pragma warning disable CA1515
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Project-less document loading: .NET file-based apps and C# scripts.
/// Covers [FILEBASED], [CSX], [SCRIPT-CLOSURE], [SCRIPT-ANTIPATTERN], [SCRIPT-DEGRADE].
/// </summary>
public sealed class WorkspaceManagerSingleFileTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-sf-tests-{Guid.NewGuid():N}"
    );

    public WorkspaceManagerSingleFileTests()
    {
        _ = Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException)
        {
            // Best-effort cleanup: an indexer or scanner can hold a transient handle.
        }
    }

    private string Write(string name, string text)
    {
        var path = Path.Combine(_root, name);
        File.WriteAllText(path, text);
        return path;
    }

    // OpenAsync is [Obsolete] as a design placeholder, not because it is unsafe. The tests must
    // exercise the real entry point rather than a private shim, so the warning is suppressed at
    // this single call site.
#pragma warning disable CS0618
    private static Task<Outcome.Result<Outcome.Unit, string>> OpenAsync(
        WorkspaceManager manager,
        string path
    )
    {
        return manager.OpenAsync(path);
    }
#pragma warning restore CS0618

    private static async Task<List<DiagnosticResult>> ErrorsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var result = await manager.GetDiagnosticsAsync(path).ConfigureAwait(false);
        Assert.False(result.IsError);
        var diagnostics = result.Match(value => value, _ => []);
        return
        [
            .. diagnostics.Where(d =>
                string.Equals(d.Severity, "error", StringComparison.OrdinalIgnoreCase)
            ),
        ];
    }

    /// <summary>
    /// The BCL metadata references must actually resolve. Asserting only that the result is not
    /// an error proves nothing — <c>GetDiagnosticsAsync</c> returns a SUCCESS result carrying a
    /// LIST of diagnostics, so a workspace with no references would still "pass". Asserting the
    /// list is empty is what proves [FILEBASED-REFERENCES-FALLBACK] works.
    /// </summary>
    [Fact]
    public async Task FileBasedApp_resolves_bcl_symbols_with_no_errors()
    {
        var app = Write("Program.cs", "Console.WriteLine(\"hello\".Length);\n");
        using var manager = new WorkspaceManager();

        var result = await OpenAsync(manager, app);

        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary>A shebang is valid in a file-based app. Implements [FILEBASED-SHEBANG].</summary>
    [Fact]
    public async Task FileBasedApp_shebang_produces_no_diagnostic()
    {
        var app = Write("shebang.cs", "#!/usr/bin/env -S dotnet --\nConsole.WriteLine(1);\n");
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary><c>#:include</c> pulls a sibling into the closure. Implements [SCRIPT-CLOSURE].</summary>
    [Fact]
    public async Task FileBasedApp_include_directive_pulls_referenced_file_into_closure()
    {
        _ = Write(
            "helpers.cs",
            "internal static class Helpers { public static int Two() { return 2; } }\n"
        );
        var app = Write(
            "WithInclude.cs",
            "#:include helpers.cs\nConsole.WriteLine(Helpers.Two());\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary>
    /// Regression test for [SCRIPT-ANTIPATTERN]. Globbing the directory compiled sibling apps
    /// into one project, producing a phantom CS0017 "more than one entry point" that a real
    /// <c>dotnet run</c> never emits. The closure must come from the root file alone.
    /// </summary>
    [Fact]
    public async Task Two_file_based_apps_in_one_directory_do_not_collide()
    {
        var first = Write("first.cs", "Console.WriteLine(\"first\");\n");
        _ = Write("second.cs", "Console.WriteLine(\"second\");\n");
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, first)).IsError);

        var errors = await ErrorsAsync(manager, first);
        Assert.DoesNotContain(
            errors,
            d => string.Equals(d.Code, "CS0017", StringComparison.Ordinal)
        );
        Assert.Empty(errors);
    }

    /// <summary>A cycle must terminate rather than recurse forever. Implements [SCRIPT-CLOSURE].</summary>
    [Fact]
    public async Task FileBasedApp_include_cycle_terminates()
    {
        _ = Write("b.cs", "#:include a.cs\ninternal static class B { }\n");
        var a = Write("a.cs", "#:include b.cs\nConsole.WriteLine(1);\n");
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, a)).IsError);
        Assert.True(manager.IsLoaded);
    }

    /// <summary>
    /// <c>.csx</c> is Roslyn scripting, not a file-based app: a bare top-level statement plus a
    /// <c>#load</c> closure must bind under <c>SourceCodeKind.Script</c>. Implements [CSX-OPTIONS].
    /// </summary>
    [Fact]
    public async Task CsxScript_loads_with_script_semantics()
    {
        _ = Write("lib.csx", "int Double(int x) { return x * 2; }\n");
        var script = Write("main.csx", "#load \"lib.csx\"\nConsole.WriteLine(Double(21));\n");
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, script)).IsError);
        Assert.Empty(await ErrorsAsync(manager, script));
    }

    /// <summary>
    /// A directory with no project and no root file is a load FAILURE, not a synthetic empty
    /// workspace. Silently succeeding turns "I could not load your code" into phantom
    /// diagnostics across the whole repo. Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task Directory_without_project_or_root_file_is_an_error()
    {
        using var manager = new WorkspaceManager();

        var result = await OpenAsync(manager, _root);

        Assert.True(result.IsError);
        Assert.False(manager.IsLoaded);
    }

    [Fact]
    public void Classify_maps_extensions_to_compilation_models()
    {
        Assert.Equal(ProjectlessKind.FileBasedApp, WorkspaceManager.Classify("a.cs"));
        Assert.Equal(ProjectlessKind.Script, WorkspaceManager.Classify("a.CSX"));
        Assert.Equal(ProjectlessKind.Unsupported, WorkspaceManager.Classify("a.md"));
        Assert.Equal(ProjectlessKind.Unsupported, WorkspaceManager.Classify("a.fs"));
    }
}
