using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath / Process banned for analyzers — we're tests

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// [SHARPLSP-ARCHITECTURE-PROJECTS-OWNERSHIP]: the F# sidecar alone design-time-builds an
/// F# project. Roslyn's <c>MSBuildWorkspace</c> loads every <c>.fsproj</c> it meets as an
/// empty stub the C# sidecar then throws away, and loading one IS a design-time build: it
/// writes <c>obj/&lt;cfg&gt;/&lt;tfm&gt;/&lt;Name&gt;.AssemblyInfo.fs</c> while the F# sidecar's own
/// build of that project writes the same file. The loser fails "being used by another
/// process", and the F# project silently degrades to its <c>&lt;Compile&gt;</c> items (#309 CI,
/// Windows <c>netfx-language</c>). The fixture's <c>Directory.Build.targets</c> records every
/// F# design-time build, so any the C# sidecar runs is caught by name.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerFSharpOwnershipTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"sharplsp-wm-fsown-{Guid.NewGuid():N}");
    private readonly string _record;
    private readonly string _libProject;
    private readonly string _appProject;
    private readonly string _program;

    public WorkspaceManagerFSharpOwnershipTests()
    {
        _record = NativePaths.Join(_root, "fsharp-design-time-builds.txt");
        _ = Write(
            "Directory.Build.targets",
            """
            <Project>
              <Target Name="SharpLspRecordFSharpDesignTimeBuild" BeforeTargets="CoreCompile"
                      Condition="'$(DesignTimeBuild)' == 'true' And '$(Language)' == 'F#'">
                <WriteLinesToFile File="$(MSBuildThisFileDirectory)fsharp-design-time-builds.txt"
                                  Lines="$(MSBuildProjectName) $(TargetFramework)" />
              </Target>
            </Project>
            """
        );
        _libProject = Write(
            "Lib/Lib.fsproj",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>netstandard2.0;net10.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <Compile Include="Library.fs" />
              </ItemGroup>
            </Project>
            """
        );
        _ = Write(
            "Lib/Library.fs",
            "namespace FsLib\n\ntype Widget() =\n    member _.Value = 42\n"
        );
        _appProject = Write(
            "App/App.csproj",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="..\Lib\Lib.fsproj" />
              </ItemGroup>
            </Project>
            """
        );
        _program = Write(
            "App/Program.cs",
            "namespace App;\n\npublic static class Program\n{\n"
                + "    public static int Use() => new FsLib.Widget().Value;\n}\n"
        );
        _ = Write(
            "Mixed.slnx",
            "<Solution>\n  <Project Path=\"Lib/Lib.fsproj\" />\n  <Project Path=\"App/App.csproj\" />\n</Solution>\n"
        );
        _ = Write(
            "FSharpOnly.slnx",
            "<Solution>\n  <Project Path=\"Lib/Lib.fsproj\" />\n</Solution>\n"
        );

        // A real build, not a design-time one, so the record starts empty; it gives the C#
        // side the F# DLL that cross-language navigation reads.
        var (exitCode, output) = DotnetBuild.Run(_appProject);
        Assert.True(exitCode == 0, $"dotnet build must succeed:\n{output}");
        Assert.False(File.Exists(_record), "a real build is not a design-time build");
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
    public async Task Opening_a_mixed_solution_never_builds_its_FSharp_project_and_still_resolves_it()
    {
        using var manager = await OpenAsync(NativePaths.Join(_root, "Mixed.slnx"));

        AssertNoFSharpDesignTimeBuild("a mixed solution");
        var lines = await File.ReadAllLinesAsync(_program);
        var line = Array.FindIndex(
            lines,
            text => text.Contains("Widget", StringComparison.Ordinal)
        );
        var column = lines[line].IndexOf("Widget", StringComparison.Ordinal);
        var definition = await manager.GetDefinitionAsync(_program, line, column);
        Assert.False(definition.IsError, definition.Match(_ => "ok", err => err));
        Assert.NotEmpty((+definition).Locations);
        var diagnostics = await manager.GetDiagnosticsAsync(_program);
        Assert.DoesNotContain(+diagnostics, diagnostic => diagnostic.Severity == "Error");
    }

    [Fact]
    public async Task Opening_an_FSharp_only_solution_builds_nothing()
    {
        using var manager = await OpenAsync(NativePaths.Join(_root, "FSharpOnly.slnx"));
        AssertNoFSharpDesignTimeBuild("a solution holding only F#");
    }

    [Fact]
    public async Task Opening_a_CSharp_project_that_references_FSharp_builds_only_the_CSharp()
    {
        using var manager = await OpenAsync(_appProject);
        AssertNoFSharpDesignTimeBuild("a C# project's F# reference");
        Assert.True(File.Exists(_libProject), "the F# project is still there, merely unbuilt");
    }

    private static async Task<WorkspaceManager> OpenAsync(string target)
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(target);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded, $"{target} must load");
        return manager;
    }

    private void AssertNoFSharpDesignTimeBuild(string opened)
    {
        var builds = File.Exists(_record) ? File.ReadAllText(_record).Trim() : "";
        Assert.True(
            builds.Length == 0,
            $"opening {opened} design-time-built F# in the C# sidecar: [{builds}]"
        );
    }

    private string Write(string relative, string text)
    {
        var path = NativePaths.Join(_root, relative);
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(path));
        File.WriteAllText(path, text);
        return path;
    }
}
