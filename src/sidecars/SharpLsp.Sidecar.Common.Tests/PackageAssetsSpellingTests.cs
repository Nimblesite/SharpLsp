#pragma warning disable RS1035 // Tests restore real projects and link folders to spell them twice.

using static SharpLsp.Sidecar.Common.Tests.SdkRestoreAssertions;

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// A project loads under the spelling its restore recorded, so a design-time build never
/// rewrites what the user's build wrote. [DEBUG-FEATURES-LAUNCH-BUILD]
/// </summary>
public sealed class PackageAssetsSpellingTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"slsp-assets-spelling-{Guid.NewGuid():N}");
    private readonly string _link = NativePaths.Temp(
        $"slsp-assets-spelling-link-{Guid.NewGuid():N}"
    );

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_link))
            {
                Directory.Delete(_link);
            }
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task A_second_spelling_of_a_restored_project_is_the_one_its_restore_recorded()
    {
        var app = await RestoredProjectAsync("App");
        _ = Directory.CreateSymbolicLink(_link, _root);
        var linked = NativePaths.Join(_link, "App", "App.csproj");

        Assert.True(File.Exists(linked), "the link reaches the restored project");
        Assert.Equal(app, PackageAssets.RestoredSpelling(linked));
        Assert.Equal(app, PackageAssets.RestoredSpelling(app));
    }

    [Fact]
    public async Task Assets_that_cannot_name_the_project_keep_the_given_spelling()
    {
        var app = await RestoredProjectAsync("App");
        var other = WriteProject("Other");
        Assert.Equal(other, PackageAssets.RestoredSpelling(other));

        var assets = NativePaths.ProjectAssetsFile(other);
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(assets));
        File.Copy(NativePaths.ProjectAssetsFile(app), assets);
        Assert.Equal(other, PackageAssets.RestoredSpelling(other));

        foreach (
            var unreadable in new[] { "{", "{}", """{"project":{"restore":{"projectPath":7}}}""" }
        )
        {
            await File.WriteAllTextAsync(assets, unreadable);
            Assert.Equal(other, PackageAssets.RestoredSpelling(other));
        }
    }

    private async Task<string> RestoredProjectAsync(string name)
    {
        var project = WriteProject(name);
        await RestoreSdkAsync(project).ConfigureAwait(false);
        return project;
    }

    private string WriteProject(string name)
    {
        var project = NativePaths.Join(_root, name, $"{name}.csproj");
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(project));
        ProjectXml().Save(project);
        return project;
    }
}
