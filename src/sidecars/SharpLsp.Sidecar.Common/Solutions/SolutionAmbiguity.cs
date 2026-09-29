namespace SharpLsp.Sidecar.Common.Solutions;

/// <summary>
/// Several solutions under one folder: which to load is the user's choice, never a guess.
/// Both sidecars refuse such a folder with the same words. Implements
/// [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH].
/// </summary>
public static class SolutionAmbiguity
{
    /// <summary>
    /// Names every candidate, so the user can copy one straight into the setting or pick it
    /// in the editor.
    /// </summary>
    public static string Describe(string path, IReadOnlyCollection<string> candidates)
    {
        var names = string.Join(", ", candidates.Select(NativePaths.NameOf));
        return $"Found {candidates.Count} solutions under '{path}' ({names}), so which one to "
            + "load is ambiguous.";
    }
}
