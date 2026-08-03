using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: these tests deliberately touch the real
// filesystem — the repo mandates testing against real files, not mocks.
#pragma warning disable CA1515
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Project-less document loading: .NET file-based apps and C# scripts.
/// Covers [SCRIPT-FILEBASED], [SCRIPT-CSX], [SCRIPT-CLOSURE], [SCRIPT-ANTIPATTERN], [SCRIPT-DEGRADE].
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

    private string WriteIn(string relativeDirectory, string name, string text)
    {
        var directory = Path.Combine(_root, relativeDirectory);
        _ = Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, name);
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
    /// list is empty is what proves [SCRIPT-FILEBASED-REFERENCES-FALLBACK] works.
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

    /// <summary>A shebang is valid in a file-based app. Implements [SCRIPT-FILEBASED-SHEBANG].</summary>
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
    /// <c>#load</c> closure must bind under <c>SourceCodeKind.Script</c>. Implements [SCRIPT-CSX-OPTIONS].
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
    /// A directory with no project and no root file defers loading, returning success so that
    /// the workspace can lazily inject independently requested files as ad-hoc projects.
    /// </summary>
    [Fact]
    public async Task Directory_without_project_or_root_file_succeeds_for_lazy_loading()
    {
        using var manager = new WorkspaceManager();

        var result = await OpenAsync(manager, _root);

        Assert.False(result.IsError);
        Assert.False(manager.IsLoaded);
    }

    /// <summary>A missing loose C# file is a load failure. Implements [SCRIPT-DEGRADE].</summary>
    [Fact]
    public async Task Projectless_directory_rejects_update_for_a_missing_file()
    {
        using var manager = new WorkspaceManager();
        var missing = Path.Combine(_root, "missing.cs");
        Assert.False((await OpenAsync(manager, _root)).IsError);

        var result = await manager.UpdateDocumentTextAsync(missing, "Console.WriteLine(1);");

        Assert.True(result.IsError);
        Assert.Contains(
            "not a file-based app or script",
            result.Match(_ => "", error => error),
            StringComparison.Ordinal
        );
        Assert.False(manager.IsLoaded);
    }

    [Fact]
    public async Task Projectless_update_reports_cancellation_as_a_result_failure()
    {
        using var manager = new WorkspaceManager();
        Assert.False((await OpenAsync(manager, _root)).IsError);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var result = await manager.UpdateDocumentTextAsync(
            Path.Combine(_root, "cancelled.cs"),
            "Console.WriteLine(1);",
            cancellation.Token
        );

        Assert.True(result.IsError);
        Assert.False(manager.IsLoaded);
    }

    /// <summary>
    /// Ambiguity is NOT absence. A root holding several solutions must surface an error
    /// naming the knob that resolves it, never degrade to lazy per-file ad-hoc projects:
    /// loose-file analysis of a real repository resolves no project reference and reports
    /// a wall of phantom "type not found" diagnostics across the whole tree, which is
    /// strictly worse than refusing to load. Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task Ambiguous_multi_solution_root_is_an_error_not_lazy_loading()
    {
        _ = WriteIn("app", "App.sln", "");
        _ = WriteIn("other", "Other.sln", "");
        using var manager = new WorkspaceManager();

        var result = await OpenAsync(manager, _root);

        Assert.True(result.IsError, "an ambiguous multi-solution root must not load lazily");
        var message = result.Match(_ => "", error => error);
        Assert.Contains("solution_path", message, StringComparison.Ordinal);
        Assert.Contains("App.sln", message, StringComparison.Ordinal);
        Assert.Contains("Other.sln", message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Opening multiple independent script files in a projectless directory lazily creates
    /// a new ad-hoc project for each of them simultaneously.
    /// </summary>
    [Fact]
    public async Task Independent_scripts_in_projectless_directory_are_lazily_loaded_simultaneously()
    {
        using var manager = new WorkspaceManager();
        var result = await OpenAsync(manager, _root);
        Assert.False(result.IsError);

        var file1 = Write("file1.cs", "Console.WriteLine(1);\n");
        var file2 = Write("file2.cs", "Console.WriteLine(2);\n");

        var update1 = await manager.UpdateDocumentTextAsync(file1, "Console.WriteLine(1);\n");
        Assert.False(update1.IsError);

        var update2 = await manager.UpdateDocumentTextAsync(file2, "Console.WriteLine(2);\n");
        Assert.False(update2.IsError);

        Assert.True(manager.IsLoaded);
        Assert.Empty(await ErrorsAsync(manager, file1));
        Assert.Empty(await ErrorsAsync(manager, file2));
    }

    /// <summary>
    /// The whole .NET 10 directive vocabulary must parse cleanly. Roslyn lexes <c>#:</c> as
    /// IGNORED trivia — the SDK owns their meaning — so a correct header contributes zero compiler
    /// diagnostics. Both payload shapes are exercised: <c>name@version</c> and bare <c>name</c> for
    /// <c>#:package</c>, <c>name=value</c> and bare <c>name</c> for <c>#:property</c>.
    /// Implements [SCRIPT-FILEBASED-DIRECTIVES].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_full_directive_header_produces_no_errors()
    {
        var app = Write(
            "Full.cs",
            "#:sdk Microsoft.NET.Sdk.Web\n"
                + "#:package Newtonsoft.Json@13.0.3\n"
                + "#:package Humanizer\n"
                + "#:property LangVersion=preview\n"
                + "#:property Nullable\n"
                + "#:project ../Lib/Lib.csproj\n"
                + "Console.WriteLine(1);\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary>
    /// A malformed or unresolvable directive degrades that directive ONLY — the rest of the file
    /// must still bind. An editor that drops the whole compilation because one
    /// <c>#:include</c> target is missing is worse than one that ignores the include.
    /// Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_unresolvable_directives_still_bind_the_rest_of_the_file()
    {
        var app = Write(
            "Degraded.cs",
            "#:frobnicate nonsense\n"
                + "#:include $(SomeMsBuildProperty)/generated.cs\n"
                + "#:include definitely-not-here.cs\n"
                + "Console.WriteLine(\"still binds\".Length);\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.True(manager.IsLoaded);

        // CS0103 is "name does not exist in the current context" — proof the root file's own
        // code lost its references, which is the failure mode this guards against.
        Assert.DoesNotContain(
            await ErrorsAsync(manager, app),
            d => string.Equals(d.Code, "CS0103", StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// <c>#:include</c> accepts a glob. Every matched file must join the closure — asserted by
    /// binding a symbol from each. Implements [SCRIPT-FILEBASED-DIRECTIVES], [SCRIPT-CLOSURE].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_glob_include_pulls_every_match_into_the_closure()
    {
        _ = WriteIn(
            "helpers",
            "One.cs",
            "internal static class One { public static int V() { return 1; } }\n"
        );
        _ = WriteIn(
            "helpers",
            "Two.cs",
            "internal static class Two { public static int V() { return 2; } }\n"
        );
        var app = Write(
            "Globbed.cs",
            "#:include helpers/*.cs\nConsole.WriteLine(One.V() + Two.V());\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary>
    /// A <c>**</c> glob must descend. A top-directory-only search would silently miss nested
    /// sources and report them as unresolved symbols. Implements [SCRIPT-FILEBASED-DIRECTIVES].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_recursive_glob_include_reaches_nested_files()
    {
        _ = WriteIn(
            Path.Combine("deep", "a", "b"),
            "Nested.cs",
            "internal static class Nested { public static int V() { return 3; } }\n"
        );
        var app = Write("Recursive.cs", "#:include deep/**/*.cs\nConsole.WriteLine(Nested.V());\n");
        using var manager = new WorkspaceManager();

        Assert.False((await OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
    }

    /// <summary>
    /// The closure is bounded so a runaway glob cannot exhaust memory. Asserted on the closure
    /// itself rather than through the workspace: "it loaded" would pass even if the bound never
    /// engaged, which is the only thing worth proving here. Implements [SCRIPT-CLOSURE].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_closure_file_count_is_bounded()
    {
        for (var i = 0; i < 70; i++)
        {
            _ = WriteIn("many", $"F{i}.cs", $"internal static class F{i} {{ }}\n");
        }
        var app = Write("Many.cs", "#:include many/*.cs\nConsole.WriteLine(1);\n");

        var closure = await DocumentClosure.ExpandFileBasedAsync(app, CancellationToken.None);

        Assert.Equal(64, closure.Files.Count);
        Assert.Contains(
            closure.Issues,
            issue => issue.Contains("exceeded 64 files", StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// Include nesting is depth-bounded, so a deep chain terminates with an explicit issue rather
    /// than recursing until the stack gives out. Implements [SCRIPT-CLOSURE].
    /// </summary>
    [Fact]
    public async Task FileBasedApp_include_depth_is_bounded()
    {
        for (var i = 0; i < 12; i++)
        {
            var next = i < 11 ? $"#:include chain{i + 1}.cs\n" : string.Empty;
            _ = Write($"chain{i}.cs", $"{next}internal static class C{i} {{ }}\n");
        }
        var app = Write("Chain.cs", "#:include chain0.cs\nConsole.WriteLine(1);\n");

        var closure = await DocumentClosure.ExpandFileBasedAsync(app, CancellationToken.None);

        Assert.Contains(
            closure.Issues,
            issue => issue.Contains("levels of #:include nesting", StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// A document that is neither a project nor a loadable C# model is a load FAILURE. Returning
    /// success would leave the host believing a workspace exists. Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task Unsupported_document_is_a_load_error()
    {
        var notes = Write("notes.txt", "not code\n");
        using var manager = new WorkspaceManager();

        var result = await OpenAsync(manager, notes);

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
