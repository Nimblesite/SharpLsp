using System.Text.Json;
using System.Xml.Linq;
using static SharpLsp.Sidecar.Common.Tests.SdkRestoreAssertions;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>Actual SDK assets must follow imported restore inputs. [DIAG-RESTORE] (GitHub #482).</summary>
public sealed class WorkspaceRestoreInputsTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"slsp-restore-inputs-{Guid.NewGuid():N}");

    private sealed record ProjectSnapshot(
        string Project,
        string Input,
        DateTime Time,
        byte[] Bytes
    );

    [Theory]
    [InlineData("direct")]
    [InlineData("nested")]
    [InlineData("inherited")]
    public async Task Imported_inputs_update_assets_without_touching_the_project(string kind)
    {
        var (project, input) = WriteProject(kind);
        var original = await ReadBytesAsync(project);
        var projectTime = new FileInfo(project).LastWriteTimeUtc;
        var snapshot = new ProjectSnapshot(project, input, projectTime, original);
        await RestoreSdkAsync(project);
        AssertPackageRoot(project, "before");
        await AssertTransitionAsync(snapshot, "after");
        await AssertTransitionAsync(snapshot, "before");
    }

    [Theory]
    [InlineData("Directory.Build.props")]
    [InlineData("Directory.Packages.props")]
    [InlineData("nuget.config")]
    public async Task Deleted_inherited_inputs_restore_SDK_defaults_then_settle(string name)
    {
        var snapshot = await ProveInheritedInputAsync(name);
        var assetsTime = new FileInfo(AssetsPath(snapshot.Project)).LastWriteTimeUtc;
        new FileInfo(snapshot.Input).Delete();
        Assert.Equal(snapshot.Time, new FileInfo(snapshot.Project).LastWriteTimeUtc);
        Assert.Equal(assetsTime, new FileInfo(AssetsPath(snapshot.Project)).LastWriteTimeUtc);
        Assert.False(WorkspaceRestoreInputs.AreCurrent(snapshot.Project, assetsTime));
        await AssertDeletionRestoredAsync(snapshot, assetsTime);
        await AssertGateSettledAsync(snapshot.Project);
    }

    [Fact]
    public async Task Cyclic_project_references_defer_to_the_real_SDK_and_recover_after_repair()
    {
        var (project, _) = WriteProject("direct");
        await RestoreSdkAsync(project);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(project, DateTime.UtcNow));
        SetReference(project, project);
        Assert.False(WorkspaceRestoreInputs.AreCurrent(project, DateTime.UtcNow));
        var result = await WorkspaceRestore.EnsureTargetAsync(project, CancellationToken.None);
        Assert.True(result.IsError, "the SDK must reject the cyclic project graph");
        SetReference(project, null);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(project, DateTime.UtcNow));
        await RestoreSdkAsync(project);
        AssertPackageRoot(project, "before");
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("malformed")]
    public async Task Invalid_imports_report_restore_failure_and_recover_after_repair(string kind)
    {
        var (project, input) = WriteProject("direct");
        var original = await ReadBytesAsync(project);
        await RestoreSdkAsync(project);
        BreakImport(input, kind);
        Assert.False(WorkspaceRestoreInputs.AreCurrent(project, DateTime.UtcNow));
        var result = await WorkspaceRestore.EnsureTargetAsync(project, CancellationToken.None);
        Assert.True(result.IsError, "invalid imports must never appear successfully restored");
        Assert.NotEmpty(result.Match(_ => string.Empty, error => error));
        Assert.Equal<byte>(original, await ReadBytesAsync(project));
        WriteInput(input, "before");
        await RestoreSdkAsync(project);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(project, DateTime.UtcNow));
        AssertPackageRoot(project, "before");
    }

    private static void BreakImport(string input, string kind)
    {
        var file = new FileInfo(input);
        if (kind == "missing")
        {
            file.Delete();
            return;
        }
        using var writer = file.CreateText();
        writer.Write("<Project");
    }

    private static void SetReference(string project, string? reference)
    {
        var document = XDocument.Load(project);
        document.Descendants("ProjectReference").Remove();
        if (reference is not null)
        {
            document.Root!.Add(
                new XElement(
                    "ItemGroup",
                    new XElement("ProjectReference", new XAttribute("Include", reference))
                )
            );
        }
        document.Save(project);
    }

    private (string Project, string Input) WriteProject(string kind, string? inheritedName = null)
    {
        var directory = NativePaths.Resolve(_root, "Project");
        new DirectoryInfo(directory).Create();
        var input = InputPath(kind, inheritedName);
        WriteInput(input, "before");
        var project = NativePaths.Resolve(directory, "Inputs.csproj");
        var xml = ProjectXml();
        if (kind != "inherited")
        {
            xml.Add(Import(kind == "nested" ? WriteNested(input) : input));
        }
        new XDocument(xml).Save(project);
        return (project, input);
    }

    private string InputPath(string kind, string? inheritedName)
    {
        var name =
            inheritedName ?? (kind == "inherited" ? "Directory.Build.props" : "Packages.props");
        return NativePaths.Resolve(_root, name);
    }

    private string WriteNested(string input)
    {
        var nested = NativePaths.Resolve(_root, "Nested.props");
        new XDocument(new XElement("Project", Import(input))).Save(nested);
        return nested;
    }

    private static XElement Import(string input)
    {
        return new("Import", new XAttribute("Project", input));
    }

    private void WriteInput(string input, string name)
    {
        new DirectoryInfo(_root).Create();
        var root = NativePaths.SameName(input, "nuget.config")
            ? NuGetConfig(name)
            : MSBuildConfig(name);
        new XDocument(root).Save(input);
    }

    private XElement NuGetConfig(string name)
    {
        return new XElement(
            "configuration",
            new XElement(
                "config",
                new XElement(
                    "add",
                    new XAttribute("key", "globalPackagesFolder"),
                    new XAttribute("value", NativePaths.Resolve(_root, name))
                )
            )
        );
    }

    private XElement MSBuildConfig(string name)
    {
        return new XElement(
            "Project",
            new XElement(
                "PropertyGroup",
                new XElement("RestorePackagesPath", NativePaths.Resolve(_root, name))
            )
        );
    }

    private async Task<ProjectSnapshot> ProveInheritedInputAsync(string name)
    {
        var (project, input) = WriteProject("inherited", name);
        var original = await ReadBytesAsync(project).ConfigureAwait(false);
        await RestoreSdkAsync(project).ConfigureAwait(false);
        await EnsureRestoredAsync(project).ConfigureAwait(false);
        AssertPackageRoot(project, "before");
        return new ProjectSnapshot(
            project,
            input,
            new FileInfo(project).LastWriteTimeUtc,
            original
        );
    }

    private static async Task AssertDeletionRestoredAsync(
        ProjectSnapshot snapshot,
        DateTime assetsTime
    )
    {
        await EnsureRestoredAsync(snapshot.Project).ConfigureAwait(false);
        Assert.Equal(snapshot.Time, new FileInfo(snapshot.Project).LastWriteTimeUtc);
        Assert.Equal<byte>(
            snapshot.Bytes,
            await ReadBytesAsync(snapshot.Project).ConfigureAwait(false)
        );
        Assert.True(new FileInfo(AssetsPath(snapshot.Project)).LastWriteTimeUtc > assetsTime);
        AssertPackageRootPath(snapshot.Project, DefaultPackagesRoot());
    }

    private static async Task AssertGateSettledAsync(string project)
    {
        var assets = AssetsPath(project);
        var assetsTime = new FileInfo(assets).LastWriteTimeUtc;
        var original = await ReadBytesAsync(assets).ConfigureAwait(false);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(project, assetsTime));
        await EnsureRestoredAsync(project).ConfigureAwait(false);
        Assert.Equal(assetsTime, new FileInfo(assets).LastWriteTimeUtc);
        Assert.Equal<byte>(original, await ReadBytesAsync(assets).ConfigureAwait(false));
        AssertPackageRootPath(project, DefaultPackagesRoot());
    }

    private async Task AssertTransitionAsync(ProjectSnapshot snapshot, string name)
    {
        var (project, input, projectTime, original) = snapshot;
        WriteInput(input, name);
        var assets = AssetsPath(project);
        new FileInfo(input).LastWriteTimeUtc = new FileInfo(assets).LastWriteTimeUtc.AddSeconds(1);
        await EnsureRestoredAsync(project).ConfigureAwait(false);
        AssertPackageRoot(project, name);
        Assert.Equal(projectTime, new FileInfo(project).LastWriteTimeUtc);
        Assert.Equal<byte>(original, await ReadBytesAsync(project).ConfigureAwait(false));
    }

    private void AssertPackageRoot(string project, string name)
    {
        AssertPackageRootPath(project, NativePaths.Resolve(_root, name));
    }

    private static void AssertPackageRootPath(string project, string expected)
    {
        using var document = ReadAssets(project);
        var roots = document
            .RootElement.GetProperty("packageFolders")
            .EnumerateObject()
            .Select(folder => folder.Name);
        Assert.Contains(roots, root => NativePaths.AreEqual(root, expected));
        var restore = document.RootElement.GetProperty("project").GetProperty("restore");
        Assert.Equal("Inputs", restore.GetProperty("projectName").GetString());
        Assert.True(
            NativePaths.AreEqual(expected, restore.GetProperty("packagesPath").GetString())
        );
        Assert.True(PackageAssets.MissingPackages(project).IsOk);
    }

    private static string AssetsPath(string project)
    {
        return NativePaths.Resolve(NativePaths.DirectoryOf(project), "obj", "project.assets.json");
    }

    private static JsonDocument ReadAssets(string project)
    {
        using var input = new FileInfo(AssetsPath(project)).OpenRead();
        return JsonDocument.Parse(input);
    }

    public void Dispose()
    {
        new DirectoryInfo(_root).Delete(recursive: true);
    }
}
