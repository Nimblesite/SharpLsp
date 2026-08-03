#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers - tests own temp fixtures
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Path-identity contract shared by both sidecars [GitHub #110]: the Rust
/// host canonicalizes paths (Windows: <c>\\?\</c>-prefixed extended-length
/// spellings) while MSBuild/Roslyn/FCS report normal-form paths — every
/// spelling of the same file must compare equal.
/// </summary>
public sealed class NativePathsTests
{
    [Fact]
    public void EqualForIdenticalAbsolutePaths()
    {
        var path = Path.Combine(Path.GetTempPath(), "NativePathsTests", "a.cs");
        Assert.True(NativePaths.AreEqual(path, path));
    }

    [Fact]
    public void EqualAcrossCaseDifferences()
    {
        // Both sidecars have always compared paths case-insensitively; the
        // shared helper must preserve that.
        Assert.True(NativePaths.AreEqual("/tmp/Project/File.cs", "/tmp/project/file.cs"));
    }

    [Fact]
    public void EqualAcrossRelativeSegments()
    {
        var direct = Path.Combine(Path.GetTempPath(), "proj", "a.cs");
        var dotted = Path.Combine(Path.GetTempPath(), "proj", "sub", "..", "a.cs");
        Assert.True(NativePaths.AreEqual(direct, dotted));
    }

    [Fact]
    public void EqualAcrossVerbatimPrefixOnWindows()
    {
        // std::fs::canonicalize in the Rust host yields \\?\C:\... spellings.
        // Non-Windows has no alternate spelling, so identity is the contract.
        var normal = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "proj", "a.csproj"));
        var verbatim = OperatingSystem.IsWindows() ? @"\\?\" + normal : normal;
        Assert.True(NativePaths.AreEqual(verbatim, normal));
        Assert.True(NativePaths.AreEqual(normal, verbatim));
    }

    [Fact]
    public void NormalizeStripsVerbatimUncPrefix()
    {
        // UNC shares canonicalize to \\?\UNC\server\share\... — the normal
        // spelling is \\server\share\... (only expressible on Windows).
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal("/srv/share/a.cs", NativePaths.NormalizeFullPath("/srv/share/a.cs"));
            return;
        }
        Assert.Equal(
            @"\\server\share\a.cs",
            NativePaths.NormalizeFullPath(@"\\?\UNC\server\share\a.cs")
        );
    }

    [Fact]
    public void DifferentFilesNeverMatch()
    {
        var left = Path.Combine(Path.GetTempPath(), "proj", "a.cs");
        var right = Path.Combine(Path.GetTempPath(), "proj", "b.cs");
        Assert.False(NativePaths.AreEqual(left, right));
    }

    [Fact]
    public void NullNeverMatches()
    {
        // Roslyn documents may carry no file path — they are never "the" file.
        var path = Path.Combine(Path.GetTempPath(), "proj", "a.cs");
        Assert.False(NativePaths.AreEqual(null, path));
        Assert.False(NativePaths.AreEqual(path, null));
        Assert.False(NativePaths.AreEqual(null, null));
    }

    [Fact]
    public void UnresolvablePathFallsBackToRawComparison()
    {
        // Path.GetFullPath rejects the empty string; the helper must degrade
        // to raw comparison instead of throwing (sidecars never crash the
        // host over a malformed path).
        Assert.Equal("", NativePaths.NormalizeFullPath(""));
        Assert.True(NativePaths.AreEqual("", ""));
        Assert.False(NativePaths.AreEqual("", "x"));
    }
}
