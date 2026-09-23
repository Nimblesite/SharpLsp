using System.Text.Json;
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
    public void Repo_pinned_sdk_ships_exactly_the_bundled_roslyn()
    {
        // Implements [DIST-RUNTIME-ACQUIRE]: an installed SDK must ship the SAME
        // Roslyn the sidecar bundles. The SDK global.json pins is the one CI and
        // every contributor runs, so a Microsoft.CodeAnalysis bump past its Roslyn
        // (a grouped dependabot bump once paired 5.9 with 10.0.303's 5.6) fails
        // here, not as a restarted server that silently loses the workspace.
        var candidates = MSBuildInstanceSelector.ToCandidates(
            MSBuildInstanceSelector.QueryInstalledSdks()
        );
        var pinned = ReadPinnedSdkVersion();
        var resolved = ResolvePinnedSdk(candidates, pinned);
        Assert.True(
            resolved.HasValue,
            $"global.json pins {pinned}, but the .NET root this process runs under ships none that "
                + $"satisfies it (found {string.Join(", ", candidates.Select(c => c.SdkVersion))}). "
                + "Discovery enumerates ONE root - the one DOTNET_ROOT or the running host selects - "
                + "so a pinned SDK installed under a DIFFERENT root is invisible here. `make` exports "
                + "the root that satisfies the pin; a bare `dotnet test` inherits whatever is set. (#295)"
        );
        var pinnedSdk = resolved.Value;
        var bundled = MSBuildInstanceSelector.ReadBundledRoslynVersion();

        Assert.NotNull(pinnedSdk.RoslynVersion);
        Assert.NotNull(bundled);
        Assert.Equal(pinnedSdk.RoslynVersion, bundled);
        Assert.Equal(
            bundled,
            MSBuildInstanceSelector.SelectMatching(candidates, bundled)?.RoslynVersion
        );
    }

    // The newest installed SDK global.json's `latestPatch` roll-forward accepts:
    // same major.minor and feature band, patch at or above the pin - the SDK
    // hostfxr resolves for this repo.
    private static MSBuildInstanceSelector.SdkCandidate? ResolvePinnedSdk(
        IReadOnlyList<MSBuildInstanceSelector.SdkCandidate> candidates,
        Version pinned
    )
    {
        return candidates
            .Where(candidate =>
                candidate.SdkVersion.Major == pinned.Major
                && candidate.SdkVersion.Minor == pinned.Minor
                && candidate.SdkVersion.Build / 100 == pinned.Build / 100
                && candidate.SdkVersion.Build >= pinned.Build
            )
            .OrderByDescending(candidate => candidate.SdkVersion)
            .Cast<MSBuildInstanceSelector.SdkCandidate?>()
            .FirstOrDefault();
    }

    private static Version ReadPinnedSdkVersion()
    {
        var globalJson = Ancestors(new DirectoryInfo(AppContext.BaseDirectory))
            .Select(directory => Path.Combine(directory.FullName, "global.json"))
            .First(File.Exists);
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        var version = document.RootElement.GetProperty("sdk").GetProperty("version").GetString();
        return Version.Parse(Assert.IsType<string>(version));
    }

    private static IEnumerable<DirectoryInfo> Ancestors(DirectoryInfo? directory)
    {
        for (; directory is not null; directory = directory.Parent)
        {
            yield return directory;
        }
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
    public void BuildNoSdkHint_is_actionable_and_names_the_sdk_and_install_tool()
    {
        var hint = MSBuildInstanceSelector.BuildNoSdkHint();

        Assert.Contains("ERROR", hint, StringComparison.Ordinal);
        Assert.Contains(".NET 10", hint, StringComparison.Ordinal);
        Assert.Contains("SDK", hint, StringComparison.Ordinal);
        // Names the automatic remedy (VS Code) and the manual one (download link).
        Assert.Contains(".NET Install Tool", hint, StringComparison.Ordinal);
        Assert.Contains("dotnet.microsoft.com", hint, StringComparison.Ordinal);
    }

    [Fact]
    public void NewestInstancePath_selects_the_highest_discovered_sdk()
    {
        // [DIST-SDK-DISCOVERY] The degraded fallback must be deterministic.
        var instances = MSBuildLocator.QueryVisualStudioInstances().ToList();
        var expected = instances.MaxBy(instance => instance.Version);

        Assert.NotNull(expected);
        Assert.Equal(expected.MSBuildPath, MSBuildInstanceSelector.NewestInstancePath(instances));
    }

    [Fact]
    public void BuildDiscoveryFailedHint_explains_degraded_mode_and_the_remedy()
    {
        // [DIST-SDK-DISCOVERY] Discovery failure remains actionable and non-fatal.
        var hint = MSBuildInstanceSelector.BuildDiscoveryFailedHint(
            new InvalidOperationException("sdk pin missing")
        );
        Assert.Contains("WARNING", hint, StringComparison.Ordinal);
        Assert.Contains("solution browsing still works", hint, StringComparison.Ordinal);
        Assert.Contains("global.json", hint, StringComparison.Ordinal);
        Assert.Contains("sdk pin missing", hint, StringComparison.Ordinal);
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

    /// <summary>A throwaway .NET root holding an `sdk/&lt;version&gt;` directory each.</summary>
    private static string FakeDotnetRoot(params string[] sdkVersions)
    {
        var root = Path.Combine(Path.GetTempPath(), $"slsp-root-{Guid.NewGuid():N}");
        foreach (var version in sdkVersions)
        {
            Directory.CreateDirectory(Path.Combine(root, "sdk", version));
        }
        return root;
    }

    [Fact]
    public void SdkCandidatesUnder_reads_release_and_prerelease_band_directories()
    {
        // [DIST-SDK-DISCOVERY] An SDK directory may carry a prerelease suffix,
        // which Version.Parse rejects outright. Missing those would under-report
        // the very installs this scan exists to find.
        var root = FakeDotnetRoot("10.0.303", "11.0.100-preview.1.25080.5", "not-an-sdk");

        try
        {
            var versions = MSBuildInstanceSelector
                .SdkCandidatesUnder(root)
                .Select(candidate => candidate.SdkVersion)
                .ToList();

            Assert.Contains(new Version(10, 0, 303), versions);
            Assert.Contains(new Version(11, 0, 100), versions);
            // A directory naming no version is skipped, never guessed at.
            Assert.Equal(2, versions.Count);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Fact]
    public void SdkCandidatesUnder_is_empty_for_a_root_that_holds_no_sdks()
    {
        // A runtime-only install has no sdk/ directory, and a path that is no
        // .NET root at all must contribute nothing rather than throw: this runs
        // on the diagnostic path, which may never take the sidecar down.
        Assert.Empty(MSBuildInstanceSelector.SdkCandidatesUnder(FakeDotnetRoot()));
        Assert.Empty(MSBuildInstanceSelector.SdkCandidatesUnder("/no/such/dotnet/root"));
    }

    [Fact]
    public void CandidateDotnetRoots_are_existing_distinct_directories()
    {
        // [DIST-SDK-DISCOVERY] The probe list is walked whenever the Roslyn match
        // fails, so it must not carry duplicates or paths that are not there.
        var roots = MSBuildInstanceSelector.CandidateDotnetRoots();

        Assert.NotEmpty(roots);
        Assert.All(roots, root => Assert.True(Directory.Exists(root), root));
        Assert.Equal(roots.Count, roots.Distinct(StringComparer.Ordinal).Count());
        // The test host runs on a real SDK, so some root must actually hold one.
        Assert.Contains(roots, root => MSBuildInstanceSelector.SdkCandidatesUnder(root).Count > 0);
    }

    [Fact]
    public void DescribeElsewhere_points_at_DOTNET_ROOT_rather_than_a_reinstall()
    {
        // Issue #295. On a machine carrying two .NET roots - a dotnet-install.sh
        // copy in ~/.dotnet beside an installer copy in /usr/local/share/dotnet -
        // the matching SDK can be installed and still invisible, because
        // discovery enumerates only the root DOTNET_ROOT selects. Telling that
        // user "no installed SDK ships Roslyn X" is false AND sends them to
        // reinstall something they already have.
        var named = MSBuildInstanceSelector.DescribeElsewhere(["/opt/other-dotnet"]);

        Assert.Contains("/opt/other-dotnet", named, StringComparison.Ordinal);
        Assert.Contains("DOTNET_ROOT", named, StringComparison.Ordinal);
        Assert.Contains("rather than installing again", named, StringComparison.Ordinal);
        // Nothing to report stays silent instead of emitting a dangling clause.
        Assert.Equal(string.Empty, MSBuildInstanceSelector.DescribeElsewhere([]));
        Assert.Equal(string.Empty, MSBuildInstanceSelector.ElsewhereHint(bundled: null));
    }

    [Fact]
    public void WarnNoMatch_does_not_claim_the_active_root_is_every_root()
    {
        // The old wording - "no installed .NET SDK ships Roslyn X" - is a claim
        // about the MACHINE made from evidence about ONE root.
        using var writer = new StringWriter();

        MSBuildInstanceSelector.WarnNoMatch(
            writer,
            new Version(99, 0, 0, 0),
            [.. MSBuildLocator.QueryVisualStudioInstances()]
        );

        var message = writer.ToString();
        Assert.Contains("the active root", message, StringComparison.Ordinal);
        Assert.DoesNotContain("no installed .NET SDK ships", message, StringComparison.Ordinal);
    }
}
