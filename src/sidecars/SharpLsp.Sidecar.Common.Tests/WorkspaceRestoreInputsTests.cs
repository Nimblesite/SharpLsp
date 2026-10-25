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

    private (string Project, string Input) WriteProject(string kind)
    {
        var directory = NativePaths.Resolve(_root, "Project");
        new DirectoryInfo(directory).Create();
        var input = InputPath(kind);
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

    private string InputPath(string kind)
    {
        var name = kind == "inherited" ? "Directory.Build.props" : "Packages.props";
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
        new XDocument(
            new XElement(
                "Project",
                new XElement(
                    "PropertyGroup",
                    new XElement("RestorePackagesPath", NativePaths.Resolve(_root, name))
                )
            )
        ).Save(input);
    }

    private async Task AssertTransitionAsync(ProjectSnapshot snapshot, string name)
    {
        var (project, input, projectTime, original) = snapshot;
        WriteInput(input, name);
        var assets = AssetsPath(project);
        new FileInfo(input).LastWriteTimeUtc = new FileInfo(assets).LastWriteTimeUtc.AddSeconds(1);
        var result = await WorkspaceRestore
            .EnsureTargetAsync(project, CancellationToken.None)
            .ConfigureAwait(false);
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        AssertPackageRoot(project, name);
        Assert.Equal(projectTime, new FileInfo(project).LastWriteTimeUtc);
        Assert.Equal<byte>(original, await ReadBytesAsync(project).ConfigureAwait(false));
    }

    private void AssertPackageRoot(string project, string name)
    {
        using var document = ReadAssets(project);
        var roots = document
            .RootElement.GetProperty("packageFolders")
            .EnumerateObject()
            .Select(folder => folder.Name);
        Assert.Contains(
            roots,
            root => NativePaths.AreEqual(root, NativePaths.Resolve(_root, name))
        );
        var restore = document.RootElement.GetProperty("project").GetProperty("restore");
        Assert.Equal("Inputs", restore.GetProperty("projectName").GetString());
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
