using System.Reflection;
using Microsoft.Build.Locator;

namespace SharpLsp.Sidecar.CSharp;

/// <summary>
/// Selects and registers the .NET SDK / MSBuild instance whose Roslyn
/// (<c>Microsoft.CodeAnalysis.dll</c>) version matches the Roslyn this sidecar
/// bundles.
///
/// MSBuildWorkspace runs an in-process design-time build that loads compiler
/// tasks from the registered SDK. Those tasks reference a specific
/// <c>Microsoft.CodeAnalysis</c> version; when it differs from the app-local
/// Roslyn the sidecar ships, the CLR resolves the app-local copy, finds a
/// version mismatch, and raises FUSION_E_REF_DEF_MISMATCH (0x80131040) —
/// "The located assembly's manifest definition does not match the assembly
/// reference" — failing every project load.
///
/// <see cref="MSBuildLocator.RegisterDefaults"/> picks the newest installed SDK
/// (honouring the working directory's global.json), so a user workspace without
/// a global.json gets the highest SDK even when its Roslyn does not match the
/// bundled one. Selecting by Roslyn version keeps both copies identical.
/// </summary>
internal static class MSBuildInstanceSelector
{
    private const string RoslynAssemblyName = "Microsoft.CodeAnalysis.dll";

    /// <summary>An installed SDK candidate and the Roslyn version it ships.</summary>
    internal readonly record struct SdkCandidate(
        Version SdkVersion,
        string MSBuildPath,
        Version? RoslynVersion
    );

    /// <summary>
    /// Registers the SDK whose Roslyn matches the bundled Roslyn, falling back to
    /// the newest installed SDK (with a diagnostic) when none matches. SDK
    /// discovery never consults the opened workspace, and every failure mode
    /// degrades to "MSBuild unavailable" rather than crashing — so the sidecar
    /// always reaches READY and can still serve MSBuild-free requests such as
    /// <c>solution/read</c>. [DIST-SDK-DISCOVERY]
    /// </summary>
    internal static void Register(TextWriter diagnostics)
    {
        if (MSBuildLocator.IsRegistered)
        {
            return;
        }

        List<VisualStudioInstance> instances;
        try
        {
            instances = QueryInstalledSdks();
        }
        catch (Exception exception)
        {
            // A workspace global.json that pins an uninstalled SDK makes
            // hostfxr_resolve_sdk2 throw. Discovery must never take the sidecar
            // down: warn and leave MSBuild unregistered (degraded mode).
            diagnostics.WriteLine(BuildDiscoveryFailedHint(exception));
            return;
        }

        if (instances.Count == 0)
        {
            // Runtime-only machine: the apphost ran us, but no SDK means no
            // MSBuild. Leave it unregistered and name the real cause and remedy.
            diagnostics.WriteLine(BuildNoSdkHint());
            return;
        }

        var bundled = ReadBundledRoslynVersion();
        var match = bundled is null ? null : SelectMatching(ToCandidates(instances), bundled);

        if (match is not { })
        {
            WarnNoMatch(diagnostics, bundled, instances);
        }

        RegisterByPath(instances, match?.MSBuildPath ?? NewestInstancePath(instances));
    }

    /// <summary>
    /// Enumerates installed SDKs without letting the opened workspace constrain
    /// (or crash) discovery. hostfxr resolves the SDK from the query's working
    /// directory, so a workspace whose <c>global.json</c> pins an uninstalled SDK
    /// would raise <c>hostfxr_resolve_sdk2</c> ("A compatible .NET SDK was not
    /// found"). Querying from the sidecar's own base directory — which carries no
    /// user <c>global.json</c> — enumerates every installed SDK so the
    /// Roslyn-matching one can be selected regardless of the workspace pin.
    /// [DIST-SDK-DISCOVERY]
    /// </summary>
    internal static List<VisualStudioInstance> QueryInstalledSdks()
    {
        var options = new VisualStudioInstanceQueryOptions
        {
            // Only .NET SDK instances ship the Roslyn the sidecar must match.
            DiscoveryTypes = DiscoveryType.DotNetSdk,
            // hostfxr resolves the SDK from this directory, honouring any
            // global.json above it; point it at a scratch directory with no
            // global.json so the opened workspace's pin can neither constrain
            // discovery to a single SDK nor crash it when that pin is missing.
            WorkingDirectory = NeutralWorkingDirectory(),
        };
        return [.. MSBuildLocator.QueryVisualStudioInstances(options)];
    }

    /// <summary>
    /// A directory with no <c>global.json</c> in its ancestry, used as the SDK
    /// discovery root so a workspace pin cannot influence it. The sidecar's own
    /// base directory is unsuitable — during development it sits under the repo's
    /// global.json — so a dedicated scratch directory under the temp root is used.
    /// [DIST-SDK-DISCOVERY]
    /// </summary>
    private static string NeutralWorkingDirectory()
    {
        var probeDir = Path.Combine(Path.GetTempPath(), "sharplsp-sdkprobe");
        _ = Directory.CreateDirectory(probeDir);
        return probeDir;
    }

    /// <summary>The MSBuild path of the newest installed SDK.</summary>
    internal static string NewestInstancePath(IReadOnlyList<VisualStudioInstance> instances)
    {
        return instances
            .OrderByDescending(instance => instance.Version)
            .Select(instance => instance.MSBuildPath)
            .First();
    }

    /// <summary>
    /// Actionable single-line hint emitted when no .NET SDK is installed at all.
    /// SharpLsp needs the .NET 10 SDK (not just the runtime) because project
    /// analysis runs an in-process MSBuild. See [DIST-RUNTIME-ACQUIRE].
    /// </summary>
    internal static string BuildNoSdkHint()
    {
        return "[sharplsp] ERROR: no .NET SDK found on this machine. SharpLsp requires the .NET 10 "
            + "SDK (not just the runtime) because project analysis runs MSBuild. In VS Code the SDK "
            + "is installed automatically via the .NET Install Tool; otherwise install it from "
            + "https://dotnet.microsoft.com/download/dotnet/10.0.";
    }

    /// <summary>
    /// Actionable hint emitted when SDK discovery itself throws — almost always a
    /// workspace <c>global.json</c> pinning a .NET SDK version that is not
    /// installed. C# analysis degrades until it is resolved, but the sidecar stays
    /// up (solution browsing and other MSBuild-free features keep working).
    /// [DIST-SDK-DISCOVERY]
    /// </summary>
    internal static string BuildDiscoveryFailedHint(Exception exception)
    {
        return "[sharplsp] WARNING: .NET SDK discovery failed, so C# project analysis is "
            + "unavailable until it is resolved (solution browsing still works). This usually means "
            + "the workspace's global.json pins a .NET SDK version that is not installed — install "
            + $"the pinned SDK or update global.json. Detail: {exception.Message}";
    }

    /// <summary>The newest candidate whose Roslyn equals <paramref name="bundledRoslyn"/>.</summary>
    internal static SdkCandidate? SelectMatching(
        IReadOnlyList<SdkCandidate> candidates,
        Version bundledRoslyn
    )
    {
        return candidates
            .Where(candidate => candidate.RoslynVersion == bundledRoslyn)
            .OrderByDescending(candidate => candidate.SdkVersion)
            .Cast<SdkCandidate?>()
            .FirstOrDefault();
    }

    /// <summary>Pairs each instance with the Roslyn version on disk beneath it.</summary>
    internal static IReadOnlyList<SdkCandidate> ToCandidates(
        IEnumerable<VisualStudioInstance> instances
    )
    {
        return
        [
            .. instances.Select(instance => new SdkCandidate(
                instance.Version,
                instance.MSBuildPath,
                ReadRoslynVersion(instance.MSBuildPath)
            )),
        ];
    }

    /// <summary>Roslyn version bundled next to the running sidecar, or null.</summary>
    internal static Version? ReadBundledRoslynVersion()
    {
        return ReadAssemblyVersion(Path.Combine(AppContext.BaseDirectory, RoslynAssemblyName));
    }

    /// <summary>Roslyn version shipped by the SDK rooted at <paramref name="msbuildPath"/>.</summary>
    internal static Version? ReadRoslynVersion(string msbuildPath)
    {
        return ReadAssemblyVersion(
            Path.Combine(msbuildPath, "Roslyn", "bincore", RoslynAssemblyName)
        );
    }

    private static void RegisterByPath(
        IReadOnlyList<VisualStudioInstance> instances,
        string msbuildPath
    )
    {
        var instance = instances.First(candidate =>
            string.Equals(candidate.MSBuildPath, msbuildPath, StringComparison.Ordinal)
        );
        MSBuildLocator.RegisterInstance(instance);
    }

    private static Version? ReadAssemblyVersion(string assemblyPath)
    {
        if (!File.Exists(assemblyPath))
        {
            return null;
        }

        try
        {
            return AssemblyName.GetAssemblyName(assemblyPath).Version;
        }
        catch (Exception exception)
            when (exception is BadImageFormatException or FileLoadException or IOException)
        {
            return null;
        }
    }

    /// <summary>Writes a diagnostic when no installed SDK ships the bundled Roslyn.</summary>
    internal static void WarnNoMatch(
        TextWriter diagnostics,
        Version? bundled,
        IReadOnlyList<VisualStudioInstance> instances
    )
    {
        var available = string.Join(
            ", ",
            ToCandidates(instances)
                .Select(c => $"{c.SdkVersion}=>Roslyn {Describe(c.RoslynVersion)}")
        );
        diagnostics.WriteLine(
            $"[sharplsp] WARNING: no installed .NET SDK ships Roslyn {Describe(bundled)} bundled by this "
                + $"sidecar; project load may fail with a Roslyn version mismatch. Installed: {available}. "
                + "Install a matching SDK or align the bundled Roslyn version."
        );
    }

    private static string Describe(Version? version)
    {
        return version?.ToString() ?? "unknown";
    }
}
