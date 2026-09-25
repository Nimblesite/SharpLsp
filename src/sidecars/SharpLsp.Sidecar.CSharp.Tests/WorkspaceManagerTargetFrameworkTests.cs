using System.Diagnostics;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // xUnit requires public test classes
#pragma warning disable RS1035 // Path.GetTempPath / Process are what these tests exercise

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A multi-targeted C# project is one Roslyn project per framework, so one source file is one
/// document per framework. Requests answer from the ACTIVE framework — the first of
/// <c>&lt;TargetFrameworks&gt;</c> until the whole project is switched — and an edit must reach
/// every framework's copy. The project is real: written, restored, and loaded through
/// <see cref="WorkspaceManager"/>. Implements [NETFX-PROJECTS-CSHARP] and [NETFX-CONTEXT].
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerTargetFrameworkTests : IDisposable
{
    private const string ProbeSource = """
        namespace Fx;

        public static class Probe
        {
        #if NETFRAMEWORK
            public static string OnFramework => "framework";
        #else
            public static string OnModern => "modern";
        #endif
        }

        """;

    private static readonly string[] Declared = ["net48", "net10.0"];

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-tfm-{Guid.NewGuid():N}"
    );
    private readonly string _project;
    private readonly string _probe;

    public WorkspaceManagerTargetFrameworkTests()
    {
        _project = WriteProject("Probe", "<TargetFrameworks>net48;net10.0</TargetFrameworks>");
        _probe = Path.Combine(_root, "Probe", "Probe.cs");
        File.WriteAllText(_probe, ProbeSource);
        Restore(_project);
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
    public async Task A_project_answers_from_its_first_framework_until_the_whole_project_is_switched()
    {
        using var manager = await OpenAsync(_project);
        var context = AssertOk(await manager.GetTargetFrameworksAsync(_probe, default));
        Assert.Equal("net48", context.Active);
        Assert.Equal(Declared, context.Available);
        Assert.Equal(_project, context.Project);
        Assert.NotNull(await HoverAsync(manager, "OnFramework"));
        Assert.Null(await HoverAsync(manager, "OnModern"));

        var switched = AssertOk(await manager.SetTargetFrameworkAsync(_probe, "net10.0", default));
        Assert.Equal("net10.0", switched.Active);
        Assert.Equal(Declared, switched.Available);
        Assert.NotNull(await HoverAsync(manager, "OnModern"));
        Assert.Null(await HoverAsync(manager, "OnFramework"));
    }

    [Fact]
    public async Task An_edit_reaches_every_framework_copy_of_the_document()
    {
        using var manager = await OpenAsync(_project);
        var edited = ProbeSource.Replace(
            "public static class Probe\n{",
            "public static class Probe\n{\n    public static string Added => \"added\";",
            StringComparison.Ordinal
        );
        Assert.False((await manager.UpdateDocumentTextAsync(_probe, edited)).IsError);
        Assert.NotNull(await HoverAsync(manager, "Added", edited));

        _ = AssertOk(await manager.SetTargetFrameworkAsync(_probe, "net10.0", default));
        Assert.NotNull(await HoverAsync(manager, "Added", edited));
    }

    [Fact]
    public async Task An_undeclared_framework_fails_by_name_and_a_file_no_project_compiles_has_none()
    {
        using var manager = await OpenAsync(_project);
        var unknown = await manager.SetTargetFrameworkAsync(_probe, "net99.0", default);
        Assert.True(unknown.IsError);
        Assert.Contains(
            "net99.0 is not a target framework of Probe.csproj",
            !unknown ?? "",
            StringComparison.Ordinal
        );

        var foreign = await manager.GetTargetFrameworksAsync(
            Path.Combine(_root, "Nowhere.cs"),
            default
        );
        var none = AssertOk(foreign);
        Assert.Null(none.Active);
        Assert.Empty(none.Available);
        Assert.Null(none.Project);
        Assert.Equal(
            "net48",
            AssertOk(await manager.GetTargetFrameworksAsync(_probe, default)).Active
        );
    }

    [Fact]
    public async Task A_single_target_project_has_no_framework_to_choose()
    {
        var single = WriteProject("Single", "<TargetFramework>net10.0</TargetFramework>");
        var source = Path.Combine(_root, "Single", "Single.cs");
        await File.WriteAllTextAsync(source, "namespace Fx;\n\npublic static class Single { }\n");
        Restore(single);
        using var manager = await OpenAsync(single);
        var context = AssertOk(await manager.GetTargetFrameworksAsync(source, default));
        Assert.Null(context.Active);
        Assert.Empty(context.Available);
        Assert.Equal(single, context.Project);
    }

    private async Task<string?> HoverAsync(
        WorkspaceManager manager,
        string identifier,
        string? source = null
    )
    {
        var lines = (source ?? ProbeSource).Split('\n');
        var line = Array.FindIndex(
            lines,
            text => text.Contains(identifier, StringComparison.Ordinal)
        );
        var character = lines[line].IndexOf(identifier, StringComparison.Ordinal) + 1;
        return AssertOk(await manager.GetHoverAsync(_probe, line, character))?.Contents;
    }

    private string WriteProject(string name, string frameworks)
    {
        var directory = Path.Combine(_root, name);
        _ = Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, $"{name}.csproj");
        File.WriteAllText(
            path,
            $"<Project Sdk=\"Microsoft.NET.Sdk\">\n  <PropertyGroup>\n    {frameworks}\n  </PropertyGroup>\n</Project>\n"
        );
        return path;
    }

    private static async Task<WorkspaceManager> OpenAsync(string project)
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // OpenAsync is the real entry point, marked obsolete as a placeholder
        var open = await manager.OpenAsync(project);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", error => error));
        return manager;
    }

    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    private static void Restore(string project)
    {
        var start = new ProcessStartInfo("dotnet", $"restore \"{project}\" --nologo -v quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"dotnet restore must succeed:\n{output}");
    }
}
