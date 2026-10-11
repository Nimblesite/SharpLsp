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

    /// <summary>
    /// The workspace walk matches extensions exactly by the case rule (".sln" is not ".slnx",
    /// whatever Windows 8.3 globbing says), keeps nested matches, and never enters build
    /// output, JS packages or a dot-directory — while a dot-named ROOT is still walked.
    /// Implements [SHARPLSP-ARCHITECTURE-PROJECTS-DISCOVERY].
    /// </summary>
    [Fact]
    public void WorkspaceFilesSkipsBuildOutputPackagesAndDotDirectories()
    {
        var root = NativePaths.Temp($".walk-{Guid.NewGuid():N}");
        string[] kept = [NativePaths.Join(root, "A.sln"), NativePaths.Join(root, "src", "B.SLN")];
        string[] skipped =
        [
            NativePaths.Join(root, "C.slnx"),
            NativePaths.Join(root, "src", "bin", "D.sln"),
            NativePaths.Join(root, "src", "OBJ", "E.sln"),
            NativePaths.Join(root, "node_modules", "F.sln"),
            NativePaths.Join(root, ".vs", "G.sln"),
        ];
        try
        {
            foreach (var path in kept.Concat(skipped))
            {
                Directory.CreateDirectory(NativePaths.DirectoryOf(path));
                File.WriteAllText(path, "");
            }

            var found = NativePaths.WorkspaceFiles(root, ".sln");

            Assert.Equal(kept.Order(NativePaths.Comparer), found.Order(NativePaths.Comparer));
            Assert.Single(NativePaths.WorkspaceFiles(root, ".slnx"));
            Assert.Empty(NativePaths.WorkspaceFiles(root, ".csproj"));
        }
        finally
        {
            Directory.Delete(root, true);
        }
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
