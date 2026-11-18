using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: these tests deliberately touch the real
// filesystem — the repo mandates testing against real files, not mocks.
#pragma warning disable CA1515
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// What a file-based app's <c>#:include</c> brings in, and at which language version the app
/// compiles. Implements [SCRIPT-FILEBASED-DIRECTIVES], [SCRIPT-FILEBASED-ENTRYPOINT] and
/// [SCRIPT-FILEBASED-PARSEOPTIONS].
/// </summary>
public sealed class FileBasedIncludeEndToEndTests : IDisposable
{
    /// <summary>The diagnostic for top-level statements in an included file.</summary>
    private const string IncludedEntryPointCode = "SLSPC0004";

    private readonly ProjectlessWorkspaceFixture _fixture = new("fb-include");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    private static async Task<List<DiagnosticResult>> ErrorsAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var diagnostics = await ProjectlessWorkspaceFixture
            .DiagnosticsAsync(manager, path)
            .ConfigureAwait(false);
        return
        [
            .. diagnostics.Where(diagnostic =>
                string.Equals(diagnostic.Severity, "error", StringComparison.OrdinalIgnoreCase)
            ),
        ];
    }

    [Fact]
    public async Task Only_source_includes_join_the_compilation_and_the_rest_are_recorded()
    {
        var helpers = _fixture.Write(
            "helpers.cs",
            "internal static class Helpers { public static int Two() { return 2; } }\n"
        );
        var data = _fixture.Write("data.json", "{ \"answer\": 42 }\n");
        var strings = _fixture.Write("Strings.resx", "<root><data name=\"Hello\" /></root>\n");
        var page = _fixture.Write("Page.razor", "<h1>@Title</h1>\n");
        var app = _fixture.Write(
            "App.cs",
            "#:include helpers.cs\n#:include data.json\n#:include Strings.resx\n#:include Page.razor\n"
                + "Console.WriteLine(Helpers.Two());\n"
        );

        // The closure compiles source alone, and records every other include by item type.
        var closure = await DocumentClosure.ExpandFileBasedAsync(app, null, default);
        Assert.Equal([app, helpers], closure.Files.Select(file => file.Path));
        Assert.Equal(
            [("None", data), ("EmbeddedResource", strings), ("Content", page)],
            closure.Items.Select(item => (item.ItemType, item.Path))
        );
        Assert.Empty(closure.Issues);

        // So JSON, resources and markup are never parsed as C#: the app has no error.
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);
        Assert.Empty(await ErrorsAsync(manager, app));
        var symbols = await manager.GetHoverAsync(app, 4, 28);
        var hover = symbols.Match(value => value?.Contents ?? "", error => error);
        Assert.Contains("Two", hover, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_included_file_with_top_level_statements_is_told_so()
    {
        var included = _fixture.Write(
            "extra.cs",
            "internal static class Extra { public static int One() { return 1; } }\nConsole.WriteLine(\"second entry point\");\n"
        );
        var app = _fixture.Write(
            "Main.cs",
            "#:include extra.cs\nConsole.WriteLine(Extra.One());\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        // The included file carries the diagnostic, on its first top-level statement, and it
        // names the root; the compiler's "only one compilation unit" error is not shown beside it.
        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, included);
        var violation = Assert.Single(diagnostics, d => d.Code == IncludedEntryPointCode);
        Assert.Equal("Error", violation.Severity, ignoreCase: true);
        Assert.Equal(1, violation.StartLine);
        Assert.Equal(0, violation.StartCharacter);
        Assert.Contains("Main.cs", violation.Message, StringComparison.Ordinal);
        Assert.Contains("top-level statements", violation.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, d => d.Code == "CS8802");

        // The root itself is clean: its own statements are the entry point.
        var root = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, app);
        Assert.DoesNotContain(root, d => d.Code is "CS8802" or IncludedEntryPointCode);

        // An included file that only declares types has nothing to be told.
        var clean = _fixture.Write("types.cs", "internal static class Types { }\n");
        var other = _fixture.Write("Other.cs", "#:include types.cs\nConsole.WriteLine(1);\n");
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, other)).IsError);
        var typesOnly = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, clean);
        Assert.DoesNotContain(typesOnly, d => d.Code == IncludedEntryPointCode);
    }

    [Theory]
    [InlineData("net8.0", "12.0")]
    [InlineData("net9.0", "13.0")]
    public async Task The_language_version_follows_the_target_framework(
        string framework,
        string languageVersion
    )
    {
        // The `field` keyword is C# 14. Before it, `field` in an accessor is an ordinary name,
        // so an app on an older framework band gets the error `dotnet build` gives it there.
        var app = _fixture.Write(
            $"Old{languageVersion[..2]}.cs",
            $"#:property TargetFramework={framework}\nConsole.WriteLine(new Box().Value);\n"
                + "internal sealed class Box { public int Value { get => field; set => field = value; } }\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        var errors = await ErrorsAsync(manager, app);
        Assert.NotEmpty(errors);
        Assert.All(errors, error => Assert.Equal(2, error.StartLine));
        Assert.All(errors, error => Assert.Equal("CS0103", error.Code));
        Assert.All(errors, error =>
            Assert.Contains("'field'", error.Message, StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task The_default_framework_compiles_at_its_own_language_version()
    {
        var app = _fixture.Write(
            "Current.cs",
            "Console.WriteLine(new Box().Value);\n"
                + "internal sealed class Box { public int Value { get => field; set => field = value; } }\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        Assert.Empty(await ErrorsAsync(manager, app));
    }
}
