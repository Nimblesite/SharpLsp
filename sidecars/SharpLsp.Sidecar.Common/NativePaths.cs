namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Native filesystem path identity shared by the sidecars. Windows
/// extended-length prefixes (<c>\\?\</c>, <c>\\?\UNC\</c>) are transparent
/// aliases of the unprefixed spelling: the Rust host canonicalizes paths
/// (<c>std::fs::canonicalize</c>) which produces the prefixed form on
/// Windows, while MSBuild, Roslyn, and FCS report normal-form paths — both
/// spellings must compare equal. Mirrors <c>strip_verbatim</c> in the host
/// (<c>src/vfs.rs</c>). [GitHub #110]
/// </summary>
public static class NativePaths
{
    private const string VerbatimUncPrefix = @"\\?\UNC\";
    private const string VerbatimPrefix = @"\\?\";

    /// <summary>
    /// Fully qualify <paramref name="path"/> and strip any Windows
    /// extended-length prefix so equivalent spellings normalize identically.
    /// Returns the input unchanged when it is not a resolvable path.
    /// </summary>
    public static string NormalizeFullPath(string path)
    {
        try
        {
            return StripVerbatim(Path.GetFullPath(path));
        }
        catch (ArgumentException)
        {
            return path;
        }
        catch (PathTooLongException)
        {
            return path;
        }
        catch (NotSupportedException)
        {
            return path;
        }
    }

    /// <summary>
    /// Case-insensitive path identity after normalization. <c>null</c>
    /// (e.g. Roslyn documents without a file path) never matches.
    /// </summary>
    public static bool AreEqual(string? left, string? right)
    {
        return left is not null
            && right is not null
            && string.Equals(
                NormalizeFullPath(left),
                NormalizeFullPath(right),
                StringComparison.OrdinalIgnoreCase
            );
    }

    private static string StripVerbatim(string path)
    {
        return path.StartsWith(VerbatimUncPrefix, StringComparison.Ordinal)
                ? string.Concat(@"\\", path.AsSpan(VerbatimUncPrefix.Length))
            : path.StartsWith(VerbatimPrefix, StringComparison.Ordinal)
                ? path[VerbatimPrefix.Length..]
            : path;
    }
}
