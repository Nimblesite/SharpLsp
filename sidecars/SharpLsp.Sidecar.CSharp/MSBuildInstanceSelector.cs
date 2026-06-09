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
    /// Registers the SDK whose Roslyn matches the bundled Roslyn. Falls back to
    /// <see cref="MSBuildLocator.RegisterDefaults"/> (with a diagnostic) when no
    /// installed SDK matches, so behaviour is never worse than the default.
    /// </summary>
    internal static void Register(TextWriter diagnostics)
    {
        if (MSBuildLocator.IsRegistered)
        {
            return;
        }

        var bundled = ReadBundledRoslynVersion();
        var instances = MSBuildLocator.QueryVisualStudioInstances().ToList();
        var match = bundled is null ? null : SelectMatching(ToCandidates(instances), bundled);

        if (match is { } chosen)
        {
            RegisterByPath(instances, chosen.MSBuildPath);
            return;
        }

        WarnNoMatch(diagnostics, bundled, instances);
        _ = MSBuildLocator.RegisterDefaults();
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
