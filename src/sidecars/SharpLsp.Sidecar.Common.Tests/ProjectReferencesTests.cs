using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers - tests own temp fixtures
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Coverage for <see cref="ProjectReferences"/>, the shared cross-language
/// project-reference resolver ([DEFINITION-CROSSLANG]). Exercises real project
/// XML and a real (stubbed) <c>bin</c> tree on disk.
/// </summary>
public sealed class ProjectReferencesTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-projrefs-{Guid.NewGuid():N}"
    );

    public ProjectReferencesTests()
    {
        Directory.CreateDirectory(_root);
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
    public void ReadReferencedProjects_returns_absolute_paths_normalizing_both_separators()
    {
        var appDir = Path.Combine(_root, "App");
        Directory.CreateDirectory(appDir);
        var csproj = Path.Combine(appDir, "App.csproj");
        File.WriteAllText(
            csproj,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <ProjectReference Include="..\Lib\Lib.fsproj" />
                <ProjectReference Include="../Shared/Shared.csproj" />
              </ItemGroup>
            </Project>
            """
        );

        var refs = ProjectReferences.ReadReferencedProjects(csproj);

        Assert.Equal(2, refs.Count);
        Assert.All(refs, r => Assert.True(Path.IsPathRooted(r), $"must be absolute: {r}"));
        Assert.Contains(refs, r => r.EndsWith("Lib.fsproj", StringComparison.Ordinal));
        Assert.Contains(refs, r => r.EndsWith("Shared.csproj", StringComparison.Ordinal));
    }

    [Fact]
    public void ReadReferencedProjects_on_missing_file_returns_empty()
    {
        Assert.Empty(
            ProjectReferences.ReadReferencedProjects(Path.Combine(_root, "does-not-exist.csproj"))
        );
    }

    [Fact]
    public void ReadReferencedProjects_on_malformed_xml_returns_empty()
    {
        var csproj = Path.Combine(_root, "Broken.csproj");
        File.WriteAllText(csproj, "<Project><ItemGroup> not closed");
        Assert.Empty(ProjectReferences.ReadReferencedProjects(csproj));
    }

    [Fact]
    public void FindOutputAssembly_returns_null_when_never_built()
    {
        var csproj = Path.Combine(_root, "Unbuilt.csproj");
        File.WriteAllText(csproj, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        Assert.Null(ProjectReferences.FindOutputAssembly(csproj));
    }

    [Fact]
    public void FindOutputAssembly_finds_dll_by_project_stem_under_bin()
    {
        var csproj = Path.Combine(_root, "Widget.csproj");
        File.WriteAllText(csproj, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        var outDir = Path.Combine(_root, "bin", "Debug", "net10.0");
        Directory.CreateDirectory(outDir);
        var dll = Path.Combine(outDir, "Widget.dll");
        File.WriteAllText(dll, "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.Equal(Path.GetFullPath(dll), Path.GetFullPath(found!));
    }

    [Fact]
    public void FindOutputAssembly_honors_explicit_AssemblyName()
    {
        var csproj = Path.Combine(_root, "Proj.csproj");
        File.WriteAllText(
            csproj,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <AssemblyName>Custom.Name</AssemblyName>
              </PropertyGroup>
            </Project>
            """
        );
        var outDir = Path.Combine(_root, "bin", "Release", "net10.0");
        Directory.CreateDirectory(outDir);
        File.WriteAllText(Path.Combine(outDir, "Custom.Name.dll"), "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.EndsWith("Custom.Name.dll", found!, StringComparison.Ordinal);
    }

    [Fact]
    public void FindOutputAssembly_falls_back_to_stem_when_project_xml_is_malformed()
    {
        var csproj = Path.Combine(_root, "Malformed.csproj");
        File.WriteAllText(csproj, "<Project> not valid xml");
        var outDir = Path.Combine(_root, "bin", "Debug", "net10.0");
        Directory.CreateDirectory(outDir);
        File.WriteAllText(Path.Combine(outDir, "Malformed.dll"), "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.EndsWith("Malformed.dll", found!, StringComparison.Ordinal);
    }
}
