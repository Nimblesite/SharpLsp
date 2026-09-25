namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Native filesystem path identity shared by the sidecars. Windows
/// extended-length prefixes (<c>\\?\</c>, <c>\\?\UNC\</c>) are transparent
/// aliases of the unprefixed spelling: the Rust host canonicalizes paths
/// (<c>std::fs::canonicalize</c>) which produces the prefixed form on
/// Windows, while MSBuild, Roslyn, and FCS report normal-form paths — both
/// spellings must compare equal. Mirrors <c>strip_verbatim</c> in the host
/// (<c>src/sharplsp/src/vfs.rs</c>). [GitHub #110]
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

    /// <summary>
    /// Whether the directory holding <paramref name="existingFile"/> tells names apart by
    /// case, probed rather than assumed from the OS: a macOS volume and a Windows directory
    /// can each be either. Read-only: the name with its case flipped must not open the same
    /// file, unless the directory stores that spelling as an entry of its own, which only a
    /// case-sensitive directory can. <c>null</c> when the file does not exist or its name has
    /// no letter to flip. [SCRIPT-CLOSURE] (GitHub #190)
    /// </summary>
    public static bool? IsCaseSensitive(string existingFile)
    {
        var directory = Path.GetDirectoryName(existingFile);
        var name = Path.GetFileName(existingFile);
        var flipped = FlipCase(name);
        return
            directory is null
            || string.Equals(flipped, name, StringComparison.Ordinal)
            || !File.Exists(existingFile)
            ? null
            : !File.Exists(Path.Combine(directory, flipped)) || Stores(directory, flipped);
    }

    /// <summary>Whether <paramref name="directory"/> holds an entry spelled exactly <paramref name="name"/>.</summary>
    private static bool Stores(string directory, string name)
    {
        var exactly = new EnumerationOptions
        {
            MatchCasing = MatchCasing.CaseSensitive,
            MatchType = MatchType.Simple,
        };
        return Directory
            .EnumerateFileSystemEntries(directory, name, exactly)
            .Any(entry => string.Equals(Path.GetFileName(entry), name, StringComparison.Ordinal));
    }

    private static string FlipCase(string name)
    {
        return string.Concat(
            name.Select(letter =>
                char.IsUpper(letter) ? char.ToLowerInvariant(letter) : char.ToUpperInvariant(letter)
            )
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
