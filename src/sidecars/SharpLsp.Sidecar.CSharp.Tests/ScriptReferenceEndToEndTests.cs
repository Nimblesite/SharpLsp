using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: these tests deliberately touch the real
// filesystem — the repo mandates testing against real files, not mocks.
#pragma warning disable CA1515
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// <c>#r</c> in a C# script: an assembly beside the script binds, a missing one says so, and a
/// NuGet reference says it is not resolved instead of failing as a file that could not be found.
/// Implements [SCRIPT-CSX-RESOLVERS].
/// </summary>
public sealed class ScriptReferenceEndToEndTests : IDisposable
{
    /// <summary>The notice for a <c>#r "nuget: …"</c> a script cannot resolve.</summary>
    private const string NuGetReferenceCode = "SLSPC0003";

    private readonly ProjectlessWorkspaceFixture _fixture = new("csx-refs");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    /// <summary>Compile a real library declaring <c>Helper.Greeter.Greet</c> to <paramref name="relativePath"/>.</summary>
    private string BuildLibrary(string relativePath)
    {
        var path = _fixture.Write(relativePath, "");
        var source =
            "namespace Helper { public static class Greeter { "
            + "public static string Greet(string name) { return \"Hello \" + name; } } }";
        var compilation = CSharpCompilation.Create(
            "Helper",
            [CSharpSyntaxTree.ParseText(source)],
            Basic.Reference.Assemblies.Net100.References.All,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        );
        var emitted = compilation.Emit(path);
        Assert.True(emitted.Success, string.Join("; ", emitted.Diagnostics));
        return path;
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
    public async Task Assembly_reference_resolves_from_the_script_directory()
    {
        _ = BuildLibrary("lib/Helper.dll");
        var script = _fixture.Write(
            "scripts/main.csx",
            "#r \"../lib/Helper.dll\"\nvar greeting = Helper.Greeter.Greet(\"world\");\nConsole.WriteLine(greeting.Length);\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, script)).IsError);

        // The library's symbols bind: no error anywhere, and its member has its real type.
        Assert.Empty(await ErrorsAsync(manager, script));
        var hover = await manager.GetHoverAsync(script, 1, 31);
        var contents = hover.Match(value => value?.Contents ?? "", error => error);
        Assert.Contains("Greet", contents, StringComparison.Ordinal);
        Assert.Contains("string", contents, StringComparison.Ordinal);

        // A member the library does not declare is still an error: the reference is real.
        var broken = _fixture.Write(
            "scripts/broken.csx",
            "#r \"../lib/Helper.dll\"\nvar greeting = Helper.Greeter.Shout(\"world\");\n"
        );
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, broken)).IsError);
        var errors = await ErrorsAsync(manager, broken);
        var missingMember = Assert.Single(errors);
        Assert.Equal("CS0117", missingMember.Code);
        Assert.Equal(1, missingMember.StartLine);
    }

    [Fact]
    public async Task Missing_assembly_and_nuget_references_each_say_what_is_wrong()
    {
        var script = _fixture.Write(
            "main.csx",
            "#r \"absent/Nothing.dll\"\n#r \"nuget: Newtonsoft.Json, 13.0.3\"\nConsole.WriteLine(1);\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, script)).IsError);
        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, script);

        // The missing assembly is the compiler's own "could not be found", on its directive.
        var missing = Assert.Single(diagnostics, diagnostic => diagnostic.Code == "CS0006");
        Assert.Equal(0, missing.StartLine);
        Assert.Contains("Nothing.dll", missing.Message, StringComparison.Ordinal);

        // The NuGet reference is not a file that went missing: it has its own notice, on its
        // directive, naming the package, and no CS0006 beside it.
        var nuget = Assert.Single(diagnostics, diagnostic => diagnostic.Code == NuGetReferenceCode);
        Assert.Equal(1, nuget.StartLine);
        Assert.Equal(0, nuget.StartCharacter);
        Assert.Equal("Warning", nuget.Severity, ignoreCase: true);
        Assert.Contains("Newtonsoft.Json", nuget.Message, StringComparison.Ordinal);
        Assert.Contains("not resolved", nuget.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(diagnostics, diagnostic =>
            diagnostic.Code == "CS0006" && diagnostic.StartLine == 1
        );

        // The rest of the script still compiles.
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.StartLine == 2);
    }
}
