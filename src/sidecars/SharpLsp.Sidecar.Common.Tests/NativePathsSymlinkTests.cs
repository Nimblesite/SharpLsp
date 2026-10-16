#pragma warning disable RS1035 // Tests create real filesystem links to verify sidecar path identity.

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>Implements [SHARPLSP-ARCHITECTURE-PATHS]: links preserve identity before a build.</summary>
public sealed class NativePathsSymlinkTests : IDisposable
{
    private readonly string root = NativePaths.Temp($"path-links-{Guid.NewGuid():N}");
    private readonly string physical;
    private readonly string alias;

    public NativePathsSymlinkTests()
    {
        physical = NativePaths.Join(root, "physical");
        alias = NativePaths.Join(root, "alias");
        _ = Directory.CreateDirectory(physical);
        File.WriteAllText(NativePaths.Join(physical, "App.cs"), "");
        _ = Directory.CreateSymbolicLink(alias, "physical");
    }

    [Theory]
    [InlineData("App.cs")]
    [InlineData("obj/Debug/net10.0/App.dll")]
    [InlineData(".agents/skills/fix/SKILL.md")]
    public void ExistingAndUnbuiltPathsShareIdentityAcrossDirectoryLinks(string relative)
    {
        var actual = NativePaths.Join(physical, relative);
        var linked = NativePaths.Join(alias, relative);
        Assert.True(NativePaths.AreEqual(actual, linked));
        Assert.Equal(NativePaths.IdentityOf(actual), NativePaths.IdentityOf(linked));
        Assert.Equal(actual, NativePaths.NormalizeFullPath(actual));
        Assert.Equal(linked, NativePaths.NormalizeFullPath(linked));
        Assert.Equal(NativePaths.WithLinksResolved(actual), NativePaths.WithLinksResolved(linked));
        var paths = new HashSet<string>(NativePaths.Comparer) { actual, linked };
        _ = Assert.Single(paths);
        Assert.False(NativePaths.AreEqual(actual, NativePaths.Join(alias, "Other.cs")));
    }

    public void Dispose()
    {
        Directory.Delete(root, recursive: true);
    }
}
