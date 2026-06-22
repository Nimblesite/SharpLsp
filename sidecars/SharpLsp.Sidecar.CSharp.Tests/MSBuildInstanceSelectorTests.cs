using Microsoft.Build.Locator;

#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

// Implements the regression guard for the Roslyn ref/def mismatch
// (FUSION_E_REF_DEF_MISMATCH / 0x80131040) that occurs when the sidecar
// registers an SDK whose Roslyn version differs from the one it bundles.
public class MSBuildInstanceSelectorTests
{
    [Fact]
    public void Picks_sdk_matching_bundled_roslyn_over_a_newer_sdk()
    {
        // Mirrors a machine with both 10.0.203 (Roslyn 5.3) and 10.0.300 (Roslyn 5.6).
        // The sidecar bundles Roslyn 5.3, so it must pick 10.0.203, not the newest.
        var candidates = new MSBuildInstanceSelector.SdkCandidate[]
        {
            new(new Version(10, 0, 300), "/sdk/10.0.300", new Version(5, 6, 0, 0)),
            new(new Version(10, 0, 203), "/sdk/10.0.203", new Version(5, 3, 0, 0)),
        };

        var chosen = MSBuildInstanceSelector.SelectMatching(candidates, new Version(5, 3, 0, 0));

        Assert.Equal("/sdk/10.0.203", chosen?.MSBuildPath);
    }

    [Fact]
    public void Picks_newest_sdk_when_several_share_the_bundled_roslyn()
    {
        var candidates = new MSBuildInstanceSelector.SdkCandidate[]
        {
            new(new Version(10, 0, 102), "/sdk/10.0.102", new Version(5, 3, 0, 0)),
            new(new Version(10, 0, 203), "/sdk/10.0.203", new Version(5, 3, 0, 0)),
        };

        var chosen = MSBuildInstanceSelector.SelectMatching(candidates, new Version(5, 3, 0, 0));

        Assert.Equal("/sdk/10.0.203", chosen?.MSBuildPath);
    }

    [Fact]
    public void Returns_null_when_no_sdk_ships_the_bundled_roslyn()
    {
        var candidates = new MSBuildInstanceSelector.SdkCandidate[]
        {
            new(new Version(10, 0, 300), "/sdk/10.0.300", new Version(5, 6, 0, 0)),
        };

        var chosen = MSBuildInstanceSelector.SelectMatching(candidates, new Version(5, 3, 0, 0));

        Assert.Null(chosen);
    }

    [Fact]
    public void Bundled_roslyn_version_is_resolvable_on_this_machine()
    {
        // The bundled Microsoft.CodeAnalysis.dll must sit next to the sidecar so a
        // matching SDK can be selected; a null here means project load will fail.
        Assert.NotNull(MSBuildInstanceSelector.ReadBundledRoslynVersion());
    }

    [Fact]
    public void ReadRoslynVersion_returns_null_when_the_sdk_path_has_no_roslyn()
    {
        // A directory that does not contain Roslyn/bincore/Microsoft.CodeAnalysis.dll.
        Assert.Null(MSBuildInstanceSelector.ReadRoslynVersion("/no/such/sdk/root"));
    }

    [Fact]
    public void ReadRoslynVersion_returns_null_for_a_non_assembly_file()
    {
        // A Microsoft.CodeAnalysis.dll that exists but is not a valid PE image makes
        // AssemblyName.GetAssemblyName throw BadImageFormatException, which the reader
        // must swallow and report as an unknown version.
        var root = Path.Combine(Path.GetTempPath(), $"slsp-msb-{Guid.NewGuid():N}");
        var bincore = Path.Combine(root, "Roslyn", "bincore");
        Directory.CreateDirectory(bincore);
        File.WriteAllText(
            Path.Combine(bincore, "Microsoft.CodeAnalysis.dll"),
            "this is not a portable executable"
        );
        try
        {
            Assert.Null(MSBuildInstanceSelector.ReadRoslynVersion(root));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void ToCandidates_pairs_each_installed_sdk_with_its_roslyn_version()
    {
        var candidates = MSBuildInstanceSelector.ToCandidates(
            MSBuildLocator.QueryVisualStudioInstances()
        );

        // The test host runs on a real SDK, so at least one instance is present and
        // its Roslyn version resolves on disk.
        Assert.NotEmpty(candidates);
        Assert.Contains(candidates, candidate => candidate.RoslynVersion is not null);
    }

    [Fact]
    public void Register_is_a_noop_once_msbuild_is_already_registered()
    {
        // The module initializer registers MSBuild before any test runs, so this
        // call must hit the already-registered guard and return without throwing.
        MSBuildInstanceSelector.Register(TextWriter.Null);

        Assert.True(MSBuildLocator.IsRegistered);
    }

    [Fact]
    public void WarnNoMatch_reports_the_bundled_roslyn_and_installed_sdks()
    {
        using var writer = new StringWriter();

        MSBuildInstanceSelector.WarnNoMatch(
            writer,
            bundled: null,
            [.. MSBuildLocator.QueryVisualStudioInstances()]
        );

        var message = writer.ToString();
        Assert.Contains("WARNING", message, StringComparison.Ordinal);
        // Describe(null) renders the missing bundled version as "unknown".
        Assert.Contains("unknown", message, StringComparison.Ordinal);
        Assert.Contains("Install a matching SDK", message, StringComparison.Ordinal);
    }
}
