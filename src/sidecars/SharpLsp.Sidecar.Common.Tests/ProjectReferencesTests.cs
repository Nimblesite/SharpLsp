#pragma warning disable RS1035 // File IO banned for analyzers - tests own temp fixtures
using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Coverage for <see cref="ProjectReferences"/>, the shared cross-language
/// project-reference resolver ([DEFINITION-CROSSLANG]). Exercises real project
/// XML and a real (stubbed) <c>bin</c> tree on disk.
/// </summary>
public sealed class ProjectReferencesTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"sharplsp-projrefs-{Guid.NewGuid():N}");

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
        var appDir = NativePaths.Resolve(_root, "App");
        Directory.CreateDirectory(appDir);
        var csproj = NativePaths.Resolve(appDir, "App.csproj");
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
        Assert.All(refs, r => Assert.True(NativePaths.IsRooted(r), $"must be absolute: {r}"));
        Assert.Contains(refs, r => r.EndsWith("Lib.fsproj", StringComparison.Ordinal));
        Assert.Contains(refs, r => r.EndsWith("Shared.csproj", StringComparison.Ordinal));
    }

    [Fact]
    public void ReadReferencedProjects_on_missing_file_returns_empty()
    {
        Assert.Empty(
            ProjectReferences.ReadReferencedProjects(
                NativePaths.Resolve(_root, "does-not-exist.csproj")
            )
        );
    }

    [Fact]
    public void ReadReferencedProjects_on_malformed_xml_returns_empty()
    {
        var csproj = NativePaths.Resolve(_root, "Broken.csproj");
        File.WriteAllText(csproj, "<Project><ItemGroup> not closed");
        Assert.Empty(ProjectReferences.ReadReferencedProjects(csproj));
    }

    [Fact]
    public void FindOutputAssembly_returns_null_when_never_built()
    {
        var csproj = NativePaths.Resolve(_root, "Unbuilt.csproj");
        File.WriteAllText(csproj, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        Assert.Null(ProjectReferences.FindOutputAssembly(csproj));
    }

    [Fact]
    public void FindOutputAssembly_finds_dll_by_project_stem_under_bin()
    {
        var csproj = NativePaths.Resolve(_root, "Widget.csproj");
        File.WriteAllText(csproj, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        var outDir = NativePaths.Resolve(_root, "bin", "Debug", "net10.0");
        Directory.CreateDirectory(outDir);
        var dll = NativePaths.Resolve(outDir, "Widget.dll");
        File.WriteAllText(dll, "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.Equal(NativePaths.NormalizeFullPath(dll), NativePaths.NormalizeFullPath(found!));
    }

    [Fact]
    public void FindOutputAssembly_honors_explicit_AssemblyName()
    {
        var csproj = NativePaths.Resolve(_root, "Proj.csproj");
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
        var outDir = NativePaths.Resolve(_root, "bin", "Release", "net10.0");
        Directory.CreateDirectory(outDir);
        File.WriteAllText(NativePaths.Resolve(outDir, "Custom.Name.dll"), "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.EndsWith("Custom.Name.dll", found!, StringComparison.Ordinal);
    }

    [Fact]
    public void FindOutputAssembly_falls_back_to_stem_when_project_xml_is_malformed()
    {
        var csproj = NativePaths.Resolve(_root, "Malformed.csproj");
        File.WriteAllText(csproj, "<Project> not valid xml");
        var outDir = NativePaths.Resolve(_root, "bin", "Debug", "net10.0");
        Directory.CreateDirectory(outDir);
        File.WriteAllText(NativePaths.Resolve(outDir, "Malformed.dll"), "stub");

        var found = ProjectReferences.FindOutputAssembly(csproj);

        Assert.NotNull(found);
        Assert.EndsWith("Malformed.dll", found!, StringComparison.Ordinal);
    }
}
