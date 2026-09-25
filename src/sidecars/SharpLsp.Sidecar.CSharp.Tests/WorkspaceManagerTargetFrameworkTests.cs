using System.Diagnostics;
using System.Xml.Linq;
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

    private const string SharedSource = """
        namespace Fx;

        public static class Shared
        {
            public static string Value => "shared";
        }

        """;

    private const string UserSource = """
        namespace Fx;

        public static class User
        {
            public static string Read() => Shared.Value;
        }

        """;

    private const string ShapeSource = """
        namespace Fx;

        public interface IShape
        {
            string Name { get; }
        }

        """;

    private const string CircleSource = """
        namespace Fx;

        public sealed class Circle : IShape
        {
            public string Name => Shared.Value;
        }

        """;

    [Fact]
    public async Task A_use_counts_once_however_many_frameworks_compile_it()
    {
        // Both frameworks compile User.cs, so each framework's copy holds its one use of
        // Shared.Value. A project-wide query answers from the ACTIVE copy alone.
        var shared = Path.Combine(_root, "Probe", "Shared.cs");
        await File.WriteAllTextAsync(shared, SharedSource);
        await File.WriteAllTextAsync(Path.Combine(_root, "Probe", "User.cs"), UserSource);
        using var manager = await OpenAsync(_project);
        await AssertOneUseAsync(manager, shared, "User.cs", "Read");

        _ = AssertOk(await manager.SetTargetFrameworkAsync(shared, "net10.0", default));
        await AssertOneUseAsync(manager, shared, "User.cs", "Read");
    }

    [Fact]
    public async Task A_reader_on_another_framework_is_searched_through_the_build_it_compiles_against()
    {
        // App answers from net10.0 while Probe, which it references, answers from net48, so
        // App compiles against Probe's net10.0 build. Queries from Probe still reach App.
        var shared = Path.Combine(_root, "Probe", "Shared.cs");
        var shape = Path.Combine(_root, "Probe", "Shape.cs");
        await File.WriteAllTextAsync(shared, SharedSource);
        await File.WriteAllTextAsync(shape, ShapeSource);
        var circle = Path.Combine(_root, "App", "Circle.cs");
        var app = WriteReader("App");
        await File.WriteAllTextAsync(circle, CircleSource);
        Restore(app);
        using var manager = await OpenAsync(app);
        _ = AssertOk(await manager.SetTargetFrameworkAsync(circle, "net10.0", default));
        Assert.Equal(
            "net48",
            AssertOk(await manager.GetTargetFrameworksAsync(shared, default)).Active
        );

        await AssertOneUseAsync(manager, shared, "Circle.cs", "Name");
        await AssertOneImplementationAsync(manager, shape);
    }

    private static async Task AssertOneUseAsync(
        WorkspaceManager manager,
        string shared,
        string user,
        string caller
    )
    {
        var (line, character) = Locate(SharedSource, "Value");
        var lenses = AssertOk(await manager.GetCodeLensesAsync(shared, default));
        Assert.Equal("1 reference", Assert.Single(lenses, lens => lens.Line == line).Title);
        Assert.Equal("1 reference", Assert.Single(lenses, lens => lens.Line == line - 2).Title);
        var references = AssertOk(
            await manager.GetReferencesAsync(shared, line, character, includeDeclaration: true)
        );
        Assert.Equal(
            ["Shared.cs", user],
            references.Locations.Select(location => Path.GetFileName(location.FilePath))
        );
        var calls = AssertOk(await manager.GetIncomingCallsAsync(shared, line, character));
        var call = Assert.Single(calls);
        Assert.Equal((caller, user), (call.Name, Path.GetFileName(call.FilePath)));
        _ = Assert.Single(call.FromRanges);
        var highlights = AssertOk(
            await manager.GetDocumentHighlightsAsync(shared, line, character)
        );
        Assert.Equal(3, Assert.Single(highlights.Highlights).Kind);
    }

    private static async Task AssertOneImplementationAsync(WorkspaceManager manager, string shape)
    {
        var (line, character) = Locate(ShapeSource, "IShape");
        var lenses = AssertOk(await manager.GetCodeLensesAsync(shape, default));
        Assert.Equal(
            ["1 reference", "1 implementation"],
            lenses.Where(lens => lens.Line == line).Select(lens => lens.Title)
        );
        var found = AssertOk(await manager.GetImplementationsAsync(shape, line, character));
        Assert.Equal("Circle.cs", Path.GetFileName(Assert.Single(found.Locations).FilePath));
        var subtypes = AssertOk(await manager.GetSubtypesAsync(shape, line, character));
        Assert.Equal("Circle", Assert.Single(subtypes).Name);
    }

    private static (int Line, int Character) Locate(string source, string identifier)
    {
        var lines = source.Split('\n');
        var line = Array.FindIndex(
            lines,
            text => text.Contains(identifier, StringComparison.Ordinal)
        );
        return (line, lines[line].IndexOf(identifier, StringComparison.Ordinal) + 1);
    }

    /// <summary>A project on both frameworks that references the Probe project.</summary>
    private string WriteReader(string name)
    {
        var path = WriteProject(name, "<TargetFrameworks>net48;net10.0</TargetFrameworks>");
        var project = XDocument.Load(path);
        project.Root!.Add(
            new XElement(
                "ItemGroup",
                new XElement("ProjectReference", new XAttribute("Include", _project))
            )
        );
        project.Save(path);
        return path;
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
