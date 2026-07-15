using System.Xml.Linq;

#pragma warning disable RS1035 // Environment/File IO banned for analyzers — tests read repo fixtures

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// Static dependency-graph consistency for the sidecar solution (GitHub #155).
/// Guards the two restore-failure classes a partial dependency bump creates:
/// a package pinned lower than in a referenced project (NU1605 downgrade) and
/// an FSharp.Core pin drifting from FSharp.Compiler.Service's exact
/// requirement (NU1608). Project files and nuspecs are read through a real
/// XML document model, never string matching.
/// </summary>
public sealed class SidecarDependencyTests
{
    [Fact]
    public void Package_pins_never_downgrade_across_project_references()
    {
        // NU1605 guard (GitHub #155): pinning a package BELOW the version a
        // referenced project pins is a restore-breaking downgrade — exactly
        // how MessagePack 3.1.7 vs 3.1.8 broke the solution.
        var downgrades = SidecarProjects().SelectMany(FindDowngrades).ToList();
        Assert.True(downgrades.Count == 0, string.Join(Environment.NewLine, downgrades));
    }

    [Fact]
    public void FSharp_Core_pin_matches_the_exact_FCS_requirement()
    {
        // NU1608 guard (GitHub #155): FCS pins FSharp.Core exactly, so every
        // project pinning FSharp.Core must use precisely the version the
        // pinned FCS requires — they only move as a matched pair.
        var projects = SidecarProjects();
        var fcsVersion = projects
            .Select(PackagePins)
            .Select(pins => pins.GetValueOrDefault("FSharp.Compiler.Service"))
            .FirstOrDefault(version => version is not null);
        Assert.NotNull(fcsVersion);

        var required = FcsRequiredFSharpCore(fcsVersion);
        foreach (var project in projects)
        {
            if (PackagePins(project).TryGetValue("FSharp.Core", out var pinned))
            {
                Assert.True(
                    required == pinned,
                    $"{Path.GetFileName(project)} pins FSharp.Core {pinned}; "
                        + $"FSharp.Compiler.Service {fcsVersion} requires exactly "
                        + $"{required} (NU1608)"
                );
            }
        }
    }

    private static IEnumerable<string> FindDowngrades(string projectPath)
    {
        var pins = PackagePins(projectPath);
        foreach (var referenced in TransitiveProjectReferences(projectPath))
        {
            foreach (var (package, version) in PackagePins(referenced))
            {
                if (
                    pins.TryGetValue(package, out var local)
                    && PinnedVersion(local) < PinnedVersion(version)
                )
                {
                    yield return $"{Path.GetFileName(projectPath)} pins {package} {local}, "
                        + $"below {version} required via {Path.GetFileName(referenced)} (NU1605)";
                }
            }
        }
    }

    private static List<string> SidecarProjects()
    {
        var root = SidecarsDirectory();
        return
        [
            .. Directory
                .EnumerateFiles(root, "*.?sproj", SearchOption.AllDirectories)
                .Where(path => !IsBuildArtifact(path)),
        ];
    }

    private static bool IsBuildArtifact(string path)
    {
        var separator = Path.DirectorySeparatorChar;
        return path.Contains($"{separator}obj{separator}", StringComparison.Ordinal)
            || path.Contains($"{separator}bin{separator}", StringComparison.Ordinal);
    }

    private static string SidecarsDirectory()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "SharpLsp.Sidecars.sln")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new InvalidOperationException(
            "SharpLsp.Sidecars.sln not found above the test base directory"
        );
    }

    private static IReadOnlyDictionary<string, string> PackagePins(string projectPath)
    {
        return XDocument
            .Load(projectPath)
            .Descendants("PackageReference")
            .Select(reference =>
                (
                    Package: reference.Attribute("Include")?.Value,
                    Version: reference.Attribute("Version")?.Value
                        ?? reference.Element("Version")?.Value
                )
            )
            .Where(pin => pin.Package is not null && pin.Version is not null)
            .ToDictionary(
                pin => pin.Package!,
                pin => pin.Version!,
                StringComparer.OrdinalIgnoreCase
            );
    }

    private static IEnumerable<string> DirectProjectReferences(string projectPath)
    {
        var directory = Path.GetDirectoryName(projectPath)!;
        return XDocument
            .Load(projectPath)
            .Descendants("ProjectReference")
            .Select(reference => reference.Attribute("Include")?.Value)
            .Where(include => include is not null)
            .Select(include => include!.Replace('\\', Path.DirectorySeparatorChar))
            .Select(include => Path.GetFullPath(Path.Combine(directory, include)));
    }

    private static HashSet<string> TransitiveProjectReferences(string projectPath)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<string>(DirectProjectReferences(projectPath));
        while (queue.TryDequeue(out var reference))
        {
            if (seen.Add(reference))
            {
                foreach (var next in DirectProjectReferences(reference))
                {
                    queue.Enqueue(next);
                }
            }
        }

        return seen;
    }

    private static Version PinnedVersion(string version)
    {
        return Version.Parse(version.Split('-')[0]);
    }

    private static string FcsRequiredFSharpCore(string fcsVersion)
    {
        var packagesRoot =
            Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".nuget",
                "packages"
            );
        var nuspec = Path.Combine(
            packagesRoot,
            "fsharp.compiler.service",
            fcsVersion,
            "fsharp.compiler.service.nuspec"
        );
        Assert.True(
            File.Exists(nuspec),
            $"FCS {fcsVersion} nuspec not found at {nuspec} — restore the solution first"
        );

        var range = XDocument
            .Load(nuspec)
            .Descendants()
            .Where(element => element.Name.LocalName == "dependency")
            .Where(element =>
                string.Equals(
                    element.Attribute("id")?.Value,
                    "FSharp.Core",
                    StringComparison.OrdinalIgnoreCase
                )
            )
            .Select(element => element.Attribute("version")?.Value)
            .FirstOrDefault(version => version is not null);
        Assert.NotNull(range);
        // Exact NuGet ranges appear as "[10.1.204]" or "[10.1.204, 10.1.204]";
        // both bounds must agree for the pin to be exact.
        var bounds = range
            .Trim('[', ']')
            .Split(',')
            .Select(bound => bound.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        Assert.True(bounds.Count == 1, $"FCS FSharp.Core range '{range}' is not an exact pin");
        return bounds[0];
    }
}
