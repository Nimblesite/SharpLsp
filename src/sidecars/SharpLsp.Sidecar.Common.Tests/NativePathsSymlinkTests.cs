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
        var probes = CountProbes(() =>
            Assert.True(Enumerable.Range(0, 100_000).All(_ => NativePaths.AreEqual(actual, same)))
        );
        Assert.Equal(0, probes);
        Assert.True(NativePaths.AreEqual(actual, NativePaths.Join(alias, "App.cs")));
    }

    [Fact]
    public void DistinctSpellingsProbeTheDiskOncePerPathNotPerLookup()
    {
        var actual = NativePaths.Join(physical, "App.cs");
        var other = NativePaths.Join(physical, "Other.cs");
        var linkedFile = NativePaths.Join(root, "linked.cs");
        File.WriteAllText(other, "");
        _ = File.CreateSymbolicLink(linkedFile, actual);
        var paths = new HashSet<string>(NativePaths.Comparer) { actual };
        var timer = System.Diagnostics.Stopwatch.StartNew();
        var probes = CountProbes(() =>
        {
            Assert.True(
                Enumerable
                    .Range(0, 100_000)
                    .All(_ => paths.Contains(NativePaths.Join(alias, "App.cs")))
            );
            Assert.True(
                Enumerable.Range(0, 100_000).All(_ => !NativePaths.AreEqual(actual, other))
            );
        });
        // The five paths these lookups touch under the root (alias/App.cs, alias, App.cs,
        // physical, Other.cs) are each probed at most once per memo lifetime, however slow the
        // machine; resolving links per lookup (#358) probed 200,000 times.
        var lifetimes = 1 + (int)(timer.Elapsed / NativePaths.ResolvedLifetime);
        Assert.True(probes <= 5 * lifetimes, $"{probes} disk probes in {timer.Elapsed}");
        Assert.Contains(linkedFile, paths);
        Assert.DoesNotContain(NativePaths.Join(alias, "Other.cs"), paths);

        File.Delete(linkedFile);
        _ = File.CreateSymbolicLink(linkedFile, other);
        Assert.DoesNotContain(linkedFile, paths);
        Assert.True(NativePaths.AreEqual(other, linkedFile));
        Assert.Equal(other, NativePaths.WithLinksResolved(linkedFile));
        Assert.False(NativePaths.ResolvedSegments.ContainsKey(linkedFile));
    }

    /// <summary>How many disk probes <paramref name="lookups"/> makes for paths under this test's root.</summary>
    private int CountProbes(Action lookups)
    {
        var rootName = NativePaths.NameOf(root);
        var probes = 0;
        NativePaths.Probed = path =>
        {
            if (NativePaths.HasDirectory(path, rootName))
            {
                _ = Interlocked.Increment(ref probes);
            }
        };
        try
        {
            lookups();
        }
        finally
        {
            NativePaths.Probed = null;
        }
        return probes;
    }

    [Fact]
    public async Task DirectoryChangesAreFollowedOnceTheirMemoExpires()
    {
        var moved = NativePaths.Join(root, "moved");
        var inside = NativePaths.Join(moved, "App.cs");
        var actual = NativePaths.Join(physical, "App.cs");
        _ = Directory.CreateDirectory(moved);
        Assert.False(NativePaths.AreEqual(inside, actual));
        Assert.Equal(inside, NativePaths.WithLinksResolved(inside));
        Assert.Equal(moved, NativePaths.WithLinksResolved(moved));

        Directory.Delete(moved);
        _ = Directory.CreateSymbolicLink(moved, "physical");
        await Task.Delay(NativePaths.ResolvedLifetime * 2).ConfigureAwait(true);
        Assert.True(NativePaths.AreEqual(inside, actual));
        Assert.Equal(actual, NativePaths.WithLinksResolved(inside));
        Assert.Equal(physical, NativePaths.WithLinksResolved(moved));
        _ = Assert.Single(new HashSet<string>(NativePaths.Comparer) { inside, actual });
        Assert.True(NativePaths.ResolvedSegments.ContainsKey(moved));

        var second = NativePaths.Join(root, "second");
        _ = Directory.CreateDirectory(second);
        await File.WriteAllTextAsync(NativePaths.Join(second, "App.cs"), "").ConfigureAwait(true);
        Directory.Delete(moved);
        _ = Directory.CreateSymbolicLink(moved, "second");
        await Task.Delay(NativePaths.ResolvedLifetime * 2).ConfigureAwait(true);
        Assert.False(NativePaths.AreEqual(inside, actual));
        Assert.True(NativePaths.AreEqual(inside, NativePaths.Join(second, "App.cs")));
        Assert.Equal(second, NativePaths.WithLinksResolved(moved));
    }

    public void Dispose()
    {
        Directory.Delete(root, recursive: true);
    }
}
