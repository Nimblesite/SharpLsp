using System.Text.Json;
using System.Xml.Linq;
using static SharpLsp.Sidecar.Common.Tests.SdkRestoreAssertions;

// RS1035: this end-to-end test deliberately writes real project files for the real SDK.
#pragma warning disable RS1035

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A project whose inputs need the SDK to evaluate them is restored once, not on every open:
/// the SDK's restore is remembered for exactly the bytes it read. [DIAG-RESTORE]
/// [PERF-PROGRESSIVE-LOAD] (GitHub #563).
/// </summary>
public sealed class WorkspaceRestoreDigestTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"slsp-restore-digest-{Guid.NewGuid():N}");

    private string Project => NativePaths.Resolve(_root, "App", "App.csproj");

    private string Common => NativePaths.Resolve(_root, "eng", "Common.props");

    private string Inherited => NativePaths.Resolve(_root, "Directory.Build.props");

    /// <summary>The shape of most real repositories: a conditional, imported package set.</summary>
    private void WriteRepository(string version)
    {
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(Project));
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(Common));
        File.WriteAllText(Project, ProjectXml().ToString());
        WriteInherited("");
        WriteCommon(version);
    }

    private void WriteInherited(string extra)
    {
        File.WriteAllText(
            Inherited,
            "<Project><Import Project=\"$(MSBuildThisFileDirectory)eng/Common.props\" />"
                + extra
                + "</Project>"
        );
    }

    private void WriteCommon(string version)
    {
        File.WriteAllText(
            Common,
            "<Project><PropertyGroup Condition=\"'$(Configuration)' != 'Never'\">"
                + "<LangVersion>latest</LangVersion></PropertyGroup><ItemGroup>"
                + $"<PackageReference Include=\"Newtonsoft.Json\" Version=\"{version}\" />"
                + "</ItemGroup></Project>"
        );
    }

    private string Library => NativePaths.Resolve(_root, "Lib", "Lib.csproj");

    private void WriteLibrary(bool nullable)
    {
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(Library));
        var xml = ProjectXml();
        if (nullable)
        {
            xml.Add(new XElement("PropertyGroup", new XElement("Nullable", "enable")));
        }
        File.WriteAllText(Library, xml.ToString());
    }

    private void ReferenceLibrary()
    {
        var reference = new XElement(
            "ProjectReference",
            new XAttribute("Include", "../Lib/Lib.csproj")
        );
        var xml = ProjectXml();
        xml.Add(new XElement("ItemGroup", reference));
        File.WriteAllText(Project, xml.ToString());
    }

    private string RestoredVersion()
    {
        using var assets = JsonDocument.Parse(
            File.ReadAllText(NativePaths.ProjectAssetsFile(Project))
        );
        var library = Assert.Single(
            assets.RootElement.GetProperty("libraries").EnumerateObject(),
            entry => entry.Name.StartsWith("Newtonsoft.Json/", StringComparison.Ordinal)
        );
        return library.Name["Newtonsoft.Json/".Length..];
    }

    private async Task<int> RestoresAfterOpenAsync()
    {
        await EnsureRestoredAsync(Project).ConfigureAwait(true);
        return WorkspaceRestore.RestoresOf(Project);
    }

    [Fact]
    public async Task An_unchanged_graph_is_restored_once_and_any_changed_byte_restores_again()
    {
        WriteRepository("13.0.3");

        // 1. The first open restores; the opens after it do not.
        Assert.Equal(1, await RestoresAfterOpenAsync());
        Assert.Equal("13.0.3", RestoredVersion());
        Assert.Equal(1, await RestoresAfterOpenAsync());
        Assert.Equal(1, await RestoresAfterOpenAsync());

        // 2. An imported byte changes while its timestamp is preserved: restored again, and
        //    the new package is the one in the assets. Then it settles.
        var written = File.GetLastWriteTimeUtc(Common);
        WriteCommon("13.0.1");
        File.SetLastWriteTimeUtc(Common, written);
        Assert.Equal(2, await RestoresAfterOpenAsync());
        Assert.Equal("13.0.1", RestoredVersion());
        Assert.Equal(2, await RestoresAfterOpenAsync());

        // 3. The restore output is replaced behind SharpLsp's back: no longer its proof.
        var assets = NativePaths.ProjectAssetsFile(Project);
        File.SetLastWriteTimeUtc(assets, File.GetLastWriteTimeUtc(assets).AddMinutes(1));
        Assert.Equal(3, await RestoresAfterOpenAsync());
        Assert.Equal(3, await RestoresAfterOpenAsync());

        // 4. An import only the SDK can resolve leaves the graph unknown: every open
        //    restores, as nothing proves what was read.
        WriteInherited(
            "<Import Project=\"$(RepositoryExtras)\" Condition=\"'$(RepositoryExtras)' != ''\" />"
        );
        Assert.Equal(4, await RestoresAfterOpenAsync());
        Assert.Equal(5, await RestoresAfterOpenAsync());

        // 5. Taking it away again returns the graph to bytes the SDK already restored into
        //    this very output: the earlier proof stands and nothing is restored.
        WriteInherited("");
        Assert.Equal(5, await RestoresAfterOpenAsync());
        Assert.Equal(5, await RestoresAfterOpenAsync());
        Assert.Equal("13.0.1", RestoredVersion());

        // 6. A project it references joins the graph: restored once more, and an edit of
        //    that project alone restores again.
        WriteLibrary(nullable: false);
        ReferenceLibrary();
        Assert.Equal(6, await RestoresAfterOpenAsync());
        Assert.Equal(6, await RestoresAfterOpenAsync());
        WriteLibrary(nullable: true);
        Assert.Equal(7, await RestoresAfterOpenAsync());
        Assert.Equal(7, await RestoresAfterOpenAsync());
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
