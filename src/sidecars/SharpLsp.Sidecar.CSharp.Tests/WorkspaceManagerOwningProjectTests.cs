using System.Diagnostics;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath / Process banned for analyzers — we're tests

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING]: a C# file that no loaded project compiles
/// answers from the project that owns it. Opening the file in the editor is enough, and the
/// workspace's own projects stay loaded (GitHub #414).
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerOwningProjectTests : IDisposable
{
    private const string Project = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
          </PropertyGroup>
        </Project>
        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-wm-owning-{Guid.NewGuid():N}");
    private readonly string _home;
    private readonly string _homeSource;
    private readonly string _lone;
    private readonly string _guard;

    public WorkspaceManagerOwningProjectTests()
    {
        _home = Write("Home/Home.csproj", Project);
        _homeSource = Write(
            "Home/Greeter.cs",
            "namespace Home;\n\n/// <summary>Says hello.</summary>\n"
                + "public static class Greeter\n{\n    public static string Hello() => \"hi\";\n}\n"
        );
        _lone = Write("Lone/Lone.csproj", Project);
        _guard = Write(
            "Lone/Guard.cs",
            "namespace Lone;\n\npublic static class Guard\n{\n"
                + "    /// <summary>Throws when the value is null.</summary>\n"
                + "    public static T AgainstNull<T>(T? value) where T : class =>\n"
                + "        value ?? throw new System.ArgumentNullException(nameof(value));\n\n"
                + "    public static int Count = AgainstNull(\"x\").Length;\n}\n"
        );
        Build(_home);
    }

    private static void Build(string project, params string[] arguments)
    {
        var (exitCode, output) = DotnetBuild.Run(project, arguments);
        Assert.True(exitCode == 0, $"dotnet build {project} must succeed:\n{output}");
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
    public async Task A_file_outside_the_loaded_project_answers_hover_from_the_project_that_owns_it()
    {
        Build(_lone);
        using var manager = await OpenGuardAsync();

        var againstNull = await HoverWithinAsync(manager, _guard, 5, 23);
        Assert.True(
            againstNull is not null,
            $"hover answers in {_guard}, which only Lone.csproj compiles"
        );
        Assert.Contains("AgainstNull", againstNull.Contents, StringComparison.Ordinal);
        Assert.Contains(
            "Throws when the value is null.",
            againstNull.Contents,
            StringComparison.Ordinal
        );

        var length = await HoverWithinAsync(manager, _guard, 8, 47);
        Assert.True(length is not null, "a second symbol answers from the same project");
        Assert.Contains("int", length.Contents, StringComparison.Ordinal);

        // The project the workspace opened still answers: it was never replaced.
        var greeter = await HoverWithinAsync(manager, _homeSource, 3, 20);
        Assert.True(greeter is not null, "the workspace's own file still answers");
        Assert.Contains("Says hello.", greeter.Contents, StringComparison.Ordinal);
    }

    /// <summary>
    /// [DIAG-RESTORE]: opening a file never builds or restores a project the workspace did not
    /// load. An owner never restored, as a fresh clone leaves Serilog, is left exactly as it
    /// is, and the edit says why the file has no project and what to run.
    /// </summary>
    [Fact]
    public async Task A_file_whose_owning_project_was_never_restored_leaves_it_untouched()
    {
        var obj = NativePaths.Join(NativePaths.DirectoryOf(_lone), "obj");
        Assert.False(Directory.Exists(obj), "the owner starts unrestored");
        using var manager = await OpenHomeAsync();

        var opened = await manager.UpdateDocumentTextAsync(
            _guard,
            await File.ReadAllTextAsync(_guard)
        );
        var message = opened.Match(_ => "ok", err => err);
        Assert.Contains("Lone.csproj", message, StringComparison.Ordinal);
        Assert.Contains("dotnet restore", message, StringComparison.Ordinal);
        Assert.False(Directory.Exists(obj), "opening the file restored nothing");

        var hover = await manager.GetHoverAsync(_guard, 5, 23);
        Assert.Null(+hover);
        Assert.False(Directory.Exists(obj), "asking it a question built nothing either");
    }

    /// <summary>
    /// Loading an owner writes nothing a build would: one built for net8.0 of its two
    /// frameworks still has net8.0 output only, so a launch that reads the output folders
    /// still sees what the user built ([DEBUG-FEATURES-LAUNCH-BUILD]).
    /// </summary>
    [Fact]
    public async Task Loading_an_owner_built_for_one_of_its_frameworks_adds_no_output_for_the_other()
    {
        _ = Write(
            "Lone/Lone.csproj",
            Project.Replace(
                "<TargetFramework>net10.0</TargetFramework>",
                "<TargetFrameworks>net8.0;net10.0</TargetFrameworks><LangVersion>latest</LangVersion>",
                StringComparison.Ordinal
            )
        );
        Build(_lone, "--framework", "net8.0");
        var outputs = NativePaths.Join(NativePaths.DirectoryOf(_lone), "bin", "Debug");
        using var manager = await OpenHomeAsync();
        var opened = await manager.UpdateDocumentTextAsync(
            _guard,
            await File.ReadAllTextAsync(_guard)
        );
        Assert.False(opened.IsError, opened.Match(_ => "ok", err => err));

        var length = await HoverWithinAsync(manager, _guard, 8, 47);
        Assert.True(length is not null, $"hover answers in {_guard} from its built owner");
        Assert.Contains("string.Length", length.Contents, StringComparison.Ordinal);
        Assert.Equal(["net8.0"], [.. Directory.GetDirectories(outputs).Select(NativePaths.NameOf)]);
    }

    /// <summary>A manager on the Home project, which never compiles Guard.cs.</summary>
    private async Task<WorkspaceManager> OpenHomeAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(_home);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        return manager;
    }

    /// <summary>A manager on the Home project, with Guard.cs, which Home never compiles, opened.</summary>
    private async Task<WorkspaceManager> OpenGuardAsync()
    {
        var manager = await OpenHomeAsync();
        var opened = await manager.UpdateDocumentTextAsync(
            _guard,
            await File.ReadAllTextAsync(_guard)
        );
        Assert.False(opened.IsError, opened.Match(_ => "ok", err => err));
        return manager;
    }

    /// <summary>
    /// The hover at (<paramref name="line"/>, <paramref name="character"/>), polled until it
    /// answers or a minute passes: the owning project loads in the background.
    /// </summary>
    private static async Task<HoverResult?> HoverWithinAsync(
        WorkspaceManager manager,
        string file,
        int line,
        int character
    )
    {
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < TimeSpan.FromSeconds(60))
        {
            var hover = await manager.GetHoverAsync(file, line, character);
            Assert.False(hover.IsError, hover.Match(_ => "ok", err => err));
            if (+hover is { } answer)
            {
                return answer;
            }
            await Task.Delay(250);
        }
        return null;
    }

    private string Write(string relative, string text)
    {
        var path = NativePaths.Join(_root, relative);
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(path));
        File.WriteAllText(path, text);
        return path;
    }
}
