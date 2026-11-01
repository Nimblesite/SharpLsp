using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit fixture type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real temp-path and process use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A real, restored four-project solution for the import quick fixes ([REFACTOR-IMPORT]):
/// <c>App</c>, the project under test, references nothing; <c>Lib</c> declares
/// <c>Shapes.Geometry.Polygon</c>; <c>Tool</c> uses the Newtonsoft.Json package; and
/// <c>Plugin</c> declares <c>Plugins.PluginHost</c> but references <c>App</c>, so referencing
/// it from <c>App</c> would be a cycle.
/// </summary>
public sealed class ImportSolutionFixture : IAsyncLifetime
{
    /// <summary>The Newtonsoft.Json version Tool uses, from the local package cache.</summary>
    public const string NewtonsoftVersion = "13.0.3";

    /// <summary>App's one source file before any test edits it.</summary>
    public const string EmptyProbe = "namespace App;\n\npublic class Probe\n{\n}\n";

    private const string ProjectTemplate = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <Nullable>enable</Nullable>
          </PropertyGroup>
        ITEMS
        </Project>
        """;

    /// <summary>The solution's root directory.</summary>
    public string Root { get; } = NativePaths.Temp($"sharplsp-imports-{Guid.NewGuid():N}");

    /// <summary>The open workspace over the whole solution.</summary>
    internal WorkspaceManager Manager { get; } = new();

    /// <summary>App's project file.</summary>
    public string AppProject => Path("App", "App.csproj");

    /// <summary>App's source file, which every test rewrites in memory.</summary>
    public string ProbeFile => Path("App", "Probe.cs");

    /// <summary>Lib's project file.</summary>
    public string LibProject => Path("Lib", "Lib.csproj");

    /// <summary>Plugin's project file.</summary>
    public string PluginProject => Path("Plugin", "Plugin.csproj");

    /// <summary>An absolute path under the solution root.</summary>
    public string Path(params string[] segments)
    {
        return NativePaths.Join([Root, .. segments]);
    }

    public async Task InitializeAsync()
    {
        WriteSolution();
        var (exitCode, output) = DotnetBuild.Restore(Path("all.slnx"));
        Assert.True(exitCode == 0, output);
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
        var opened = await Manager.OpenAsync(Path("all.slnx"));
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
    }

    public Task DisposeAsync()
    {
        Manager.Dispose();
        try
        {
            Directory.Delete(Root, true);
        }
        catch (IOException) { }
        return Task.CompletedTask;
    }

    private void WriteSolution()
    {
        Write(LibProject, Project(""));
        Write(
            Path("Lib", "Polygon.cs"),
            "namespace Shapes.Geometry;\n\npublic class Polygon { }\n"
        );
        var newtonsoft =
            $"<PackageReference Include=\"Newtonsoft.Json\" Version=\"{NewtonsoftVersion}\" />";
        Write(Path("Tool", "Tool.csproj"), Project(newtonsoft));
        Write(
            Path("Tool", "Use.cs"),
            "namespace Tool;\n\npublic static class Use\n{\n    public static object Make() => new Newtonsoft.Json.Linq.JObject();\n}\n"
        );
        Write(PluginProject, Project("<ProjectReference Include=\"../App/App.csproj\" />"));
        Write(
            Path("Plugin", "PluginHost.cs"),
            "namespace Plugins;\n\npublic class PluginHost { }\n"
        );
        Write(AppProject, Project(""));
        Write(ProbeFile, EmptyProbe);
        Write(
            Path("all.slnx"),
            "<Solution>\n  <Project Path=\"Lib/Lib.csproj\" />\n  <Project Path=\"Tool/Tool.csproj\" />\n  <Project Path=\"Plugin/Plugin.csproj\" />\n  <Project Path=\"App/App.csproj\" />\n</Solution>\n"
        );
    }

    private static string Project(string items)
    {
        return ProjectTemplate.Replace(
            "ITEMS",
            items.Length == 0 ? "" : $"  <ItemGroup>\n    {items}\n  </ItemGroup>",
            StringComparison.Ordinal
        );
    }

    private static void Write(string path, string text)
    {
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(path));
        File.WriteAllText(path, text);
    }
}
