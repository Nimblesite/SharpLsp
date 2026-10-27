using System.Collections.Concurrent;
using SharpLsp.Sidecar.Common.Solutions;

namespace SharpLsp.Sidecar.Common;

/// <summary>Process-local inherited inputs last proven for each project graph. [DIAG-RESTORE]</summary>
internal static class WorkspaceRestoreProof
{
    private static readonly ConcurrentDictionary<string, string[]> Ancestors = new(
        NativePaths.Comparer
    );

    internal static bool AreCurrent(string project)
    {
        return Visit(project, new HashSet<string>(NativePaths.Comparer), RememberedCurrent);
    }

    internal static void Record(string project)
    {
        _ = Visit(project, new HashSet<string>(NativePaths.Comparer), Remember);
    }

    private static bool Visit(string project, HashSet<string> visited, Func<string, bool> inspect)
    {
        return !visited.Add(project)
            || (
                inspect(project)
                && ProjectReferences
                    .ReadReferencedProjects(project)
                    .All(reference => Visit(reference, visited, inspect))
            );
    }

    private static bool RememberedCurrent(string project)
    {
        return !Ancestors.TryGetValue(project, out var inputs) || inputs.All(File.Exists);
    }

    private static bool Remember(string project)
    {
        Ancestors[project] = [.. NativePaths.RestoreAncestorFiles(project)];
        return true;
    }
}
