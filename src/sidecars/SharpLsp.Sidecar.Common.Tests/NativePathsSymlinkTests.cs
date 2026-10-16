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

    [Fact]
    public void RetargetedFileLinksUseTheirCurrentIdentity()
    {
        var first = NativePaths.Join(physical, "App.cs");
        var second = NativePaths.Join(physical, "Other.cs");
        var linked = NativePaths.Join(root, "linked.cs");
        File.WriteAllText(second, "");
        _ = File.CreateSymbolicLink(linked, first);
        Assert.True(NativePaths.AreEqual(first, linked));
        Assert.Equal(first, NativePaths.WithLinksResolved(linked));
        File.Delete(linked);
        _ = File.CreateSymbolicLink(linked, second);
        Assert.False(NativePaths.AreEqual(first, linked));
        Assert.True(NativePaths.AreEqual(second, linked));
        Assert.Equal(second, NativePaths.WithLinksResolved(linked));
    }

    [Fact]
    public void IdenticalSpellingsDoNotPayForRepeatedFilesystemProbes()
    {
        var actual = NativePaths.Join(physical, "App.cs");
        var same = new string(actual.ToCharArray());
        var timer = System.Diagnostics.Stopwatch.StartNew();
        Assert.True(Enumerable.Range(0, 100_000).All(_ => NativePaths.AreEqual(actual, same)));
        Assert.True(timer.Elapsed < TimeSpan.FromSeconds(1), $"Path lookups took {timer.Elapsed}");
        Assert.True(NativePaths.AreEqual(actual, NativePaths.Join(alias, "App.cs")));
    }

    public void Dispose()
    {
        Directory.Delete(root, recursive: true);
    }
}
