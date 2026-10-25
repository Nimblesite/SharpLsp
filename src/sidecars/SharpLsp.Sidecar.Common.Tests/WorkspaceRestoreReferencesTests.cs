using System.Text.Json;
using System.Xml.Linq;
using static SharpLsp.Sidecar.Common.Tests.SdkRestoreAssertions;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>Real SDK snapshots follow timestamp-preserving reference edits. [DIAG-RESTORE] (#485).</summary>
public sealed class WorkspaceRestoreReferencesTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"slsp-restore-refs-{Guid.NewGuid():N}");

    private sealed record ReferenceProject(string Project, string Version, DateTime Time);

    [Theory]
    [InlineData("remove")]
    [InlineData("exact-range")]
    [InlineData("metadata")]
    [InlineData("include-assets")]
    [InlineData("child-version")]
    public async Task Preserved_timestamps_cannot_hide_reference_changes_or_repairs(string kind)
    {
        var version = await ImplicitVersionAsync();
        var state = CreateProject(version);
        await RestoreSdkAsync(state.Project);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(state.Project, DateTime.UtcNow));
        await AssertTransitionAsync(state, kind, kind == "child-version");
        await AssertTransitionAsync(state, "literal", kind == "child-version");
    }

    private async Task<string> ImplicitVersionAsync()
    {
        new DirectoryInfo(_root).Create();
        var project = NativePaths.Resolve(_root, "Implicit.fsproj");
        new XDocument(ProjectXml()).Save(project);
        await RestoreSdkAsync(project).ConfigureAwait(false);
        using var document = PackageAssets.ReadDocument(project);
        var package = Assert.Single(
            document.RootElement.GetProperty("libraries").EnumerateObject()
        );
        Assert.StartsWith("FSharp.Core/", package.Name, StringComparison.Ordinal);
        // NuGet's package identity is data, not a filesystem path.
        return package.Name["FSharp.Core/".Length..];
    }

    private ReferenceProject CreateProject(string version)
    {
        var directory = NativePaths.Resolve(_root, "Main");
        new DirectoryInfo(directory).Create();
        using var source = new FileInfo(NativePaths.Resolve(directory, "Library.cs")).CreateText();
        source.Write("public static class ReferenceFixture { public static int Value => 42; }");
        var project = NativePaths.Resolve(directory, "References.csproj");
        WriteProject(project, version, "literal");
        return new ReferenceProject(project, version, new FileInfo(project).LastWriteTimeUtc);
    }

    private static void WriteProject(string project, string version, string kind)
    {
        var xml = ProjectXml();
        if (kind != "remove")
        {
            xml.Add(new XElement("ItemGroup", PackageXml(version, kind)));
        }
        new XDocument(xml).Save(project);
    }

    private static XElement PackageXml(string version, string kind)
    {
        return new XElement(
            "PackageReference",
            new XAttribute("Include", "FSharp.Core"),
            VersionMetadata(version, kind),
            kind == "metadata" ? new XAttribute("PrivateAssets", "all") : null,
            kind == "include-assets" ? new XAttribute("IncludeAssets", "none") : null
        );
    }

    private static XObject VersionMetadata(string version, string kind)
    {
        return kind == "child-version"
            ? new XElement("Version", version)
            : new XAttribute("Version", kind == "exact-range" ? $"[{version}]" : version);
    }

    private static async Task AssertTransitionAsync(
        ReferenceProject state,
        string kind,
        bool unchanged
    )
    {
        WriteProject(state.Project, state.Version, kind);
        new FileInfo(state.Project).LastWriteTimeUtc = state.Time;
        Assert.Equal(unchanged, WorkspaceRestoreInputs.AreCurrent(state.Project, DateTime.UtcNow));
        var result = await WorkspaceRestore
            .EnsureTargetAsync(state.Project, CancellationToken.None)
            .ConfigureAwait(false);
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        Assert.Equal(state.Time, new FileInfo(state.Project).LastWriteTimeUtc);
        AssertSdkState(state, kind);
    }

    private static void AssertSdkState(ReferenceProject state, string kind)
    {
        using var document = PackageAssets.ReadDocument(state.Project);
        var libraries = document.RootElement.GetProperty("libraries");
        Assert.Equal(
            kind != "remove",
            libraries.TryGetProperty($"FSharp.Core/{state.Version}", out _)
        );
        if (kind == "remove")
        {
            Assert.Empty(libraries.EnumerateObject());
            return;
        }
        AssertDependency(document.RootElement, kind);
    }

    private static void AssertDependency(JsonElement assets, string kind)
    {
        var framework = Assert
            .Single(assets.GetProperty("project").GetProperty("frameworks").EnumerateObject())
            .Value;
        var dependency = framework.GetProperty("dependencies").GetProperty("FSharp.Core");
        Assert.Equal("Package", dependency.GetProperty("target").GetString());
        var range = dependency.GetProperty("version").GetString();
        Assert.NotNull(range);
        Assert.Equal(kind == "exact-range", range.EndsWith(']'));
        AssertMetadata(dependency, kind);
    }

    private static void AssertMetadata(JsonElement dependency, string kind)
    {
        Assert.Equal(
            kind == "metadata",
            dependency.TryGetProperty("suppressParent", out var parent)
                && parent.GetString() == "All"
        );
        Assert.Equal(
            kind == "include-assets",
            dependency.TryGetProperty("include", out var include) && include.GetString() == "None"
        );
    }

    [Theory]
    [InlineData("TargetFramework", "net10.0", "netstandard2.1")]
    [InlineData("TargetFrameworks", "net10.0", "net10.0;netstandard2.1")]
    [InlineData("TargetFrameworks", "net10.0;netstandard2.1", "net10.0")]
    public async Task Preserved_timestamps_cannot_hide_framework_changes_or_repairs(
        string property,
        string initial,
        string changed
    )
    {
        var state = CreateProject(await ImplicitVersionAsync());
        WriteFrameworkProject(state, property, initial);
        await RestoreSdkAsync(state.Project);
        AssertFrameworks(state, initial);
        await AssertFrameworkTransitionAsync(state, property, changed);
        await AssertFrameworkTransitionAsync(state, property, initial);
    }

    [Fact]
    public async Task Reordering_the_same_framework_set_preserves_the_actual_SDK_snapshot()
    {
        var state = CreateProject(await ImplicitVersionAsync());
        WriteFrameworkProject(state, "TargetFrameworks", "net10.0;netstandard2.1");
        await RestoreSdkAsync(state.Project);
        var assets = NativePaths.ProjectAssetsFile(state.Project);
        var before = await ReadBytesAsync(assets);
        WriteFrameworkProject(state, "TargetFrameworks", "netstandard2.1;net10.0");
        AssertFrameworks(state, "netstandard2.1;net10.0");
        var result = await WorkspaceRestore.EnsureTargetAsync(
            state.Project,
            CancellationToken.None
        );
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        Assert.Equal<byte>(before, await ReadBytesAsync(assets));
    }

    private static void WriteFrameworkProject(ReferenceProject state, string property, string value)
    {
        WriteProject(state.Project, state.Version, "literal");
        var document = XDocument.Load(state.Project);
        var group = Assert.Single(document.Root!.Elements("PropertyGroup"));
        group.ReplaceNodes(new XElement(property, value));
        document.Save(state.Project);
        new FileInfo(state.Project).LastWriteTimeUtc = state.Time;
    }

    private static async Task AssertFrameworkTransitionAsync(
        ReferenceProject state,
        string property,
        string value
    )
    {
        WriteFrameworkProject(state, property, value);
        Assert.False(WorkspaceRestoreInputs.AreCurrent(state.Project, DateTime.UtcNow));
        var result = await WorkspaceRestore
            .EnsureTargetAsync(state.Project, CancellationToken.None)
            .ConfigureAwait(false);
        Assert.True(result.IsOk, result.Match(_ => string.Empty, error => error));
        AssertFrameworks(state, value);
    }

    private static void AssertFrameworks(ReferenceProject state, string expected)
    {
        using var assets = PackageAssets.ReadDocument(state.Project);
        var restored = assets.RootElement.GetProperty("project").GetProperty("restore");
        var frameworks = restored
            .GetProperty("originalTargetFrameworks")
            .EnumerateArray()
            .Select(value => Assert.IsType<string>(value.GetString()));
        Assert.Equal(
            expected.Split(';').Order(StringComparer.Ordinal),
            frameworks.Order(StringComparer.Ordinal)
        );
        Assert.Equal(state.Time, new FileInfo(state.Project).LastWriteTimeUtc);
        Assert.True(WorkspaceRestoreInputs.AreCurrent(state.Project, DateTime.UtcNow));
    }

    public void Dispose()
    {
        new DirectoryInfo(_root).Delete(recursive: true);
    }
}
