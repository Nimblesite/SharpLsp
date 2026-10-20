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

    private static void Build(string project)
    {
        var (exitCode, output) = DotnetBuild.Run(project);
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
    /// [DIAG-RESTORE]: an owner never restored, as a freshly cloned repository leaves it, is
    /// restored before it loads. Serilog's shape: several frameworks, netstandard first, whose
    /// reference assemblies come from the NETStandard.Library package, so until a restore
    /// fetches it the file checks against no framework at all.
    /// </summary>
    [Fact]
    public async Task A_file_whose_owning_project_was_never_restored_answers_once_it_is()
    {
        var assets = NativePaths.Join(NativePaths.DirectoryOf(_lone), "obj", "project.assets.json");
        _ = Write(
            "Lone/Lone.csproj",
            Project.Replace(
                "<TargetFramework>net10.0</TargetFramework>",
                "<TargetFrameworks>netstandard2.0;net10.0</TargetFrameworks>"
                    + "<LangVersion>latest</LangVersion>",
                StringComparison.Ordinal
            )
        );
        Assert.False(File.Exists(assets), "the owner starts unrestored");
        using var manager = await OpenGuardAsync();

        var length = await HoverWithinAsync(manager, _guard, 8, 47);
        Assert.True(length is not null, $"hover answers in {_guard} once Lone.csproj is restored");
        Assert.Contains("string.Length", length.Contents, StringComparison.Ordinal);
        Assert.True(File.Exists(assets), "Lone.csproj was restored");

        var againstNull = await HoverWithinAsync(manager, _guard, 5, 23);
        Assert.True(againstNull is not null, "a second symbol answers from the restored owner");
        Assert.Contains(
            "Throws when the value is null.",
            againstNull.Contents,
            StringComparison.Ordinal
        );
    }

    /// <summary>A manager on the Home project, with Guard.cs, which Home never compiles, opened.</summary>
    private async Task<WorkspaceManager> OpenGuardAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(_home);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));

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
