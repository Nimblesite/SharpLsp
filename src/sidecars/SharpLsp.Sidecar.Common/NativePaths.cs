namespace SharpLsp.Sidecar.Common;

/// <summary>
/// The ONE place both sidecars handle paths: normalization, identity, the case rule,
/// resolution against a directory, the pieces of a path and extension tests all live
/// here and nowhere else. Windows extended-length prefixes (<c>\\?\</c>, <c>\\?\UNC\</c>)
/// are transparent aliases of the unprefixed spelling: the Rust host canonicalizes paths
/// (<c>std::fs::canonicalize</c>) which produces the prefixed form on Windows, while
/// MSBuild, Roslyn, and FCS report normal-form paths — both spellings must compare equal.
/// Mirrors the host's path module (<c>src/sharplsp/src/paths.rs</c>). [GitHub #110]
/// Implements [SHARPLSP-ARCHITECTURE-PATHS].
/// </summary>
public static class NativePaths
{
    private const string VerbatimUncPrefix = @"\\?\UNC\";
    private const string VerbatimPrefix = @"\\?\";

    /// <summary>
    /// The one case rule for path identity: names differing only in case are one file.
    /// Windows and the default macOS volume tell names apart that way, and a directory
    /// holding two names that differ only in case is a project no build tool tells apart
    /// either. Decided once here; no caller picks a rule of its own.
    /// </summary>
    private const StringComparison Comparison = StringComparison.OrdinalIgnoreCase;

    /// <summary>
    /// The comparer every path-keyed collection is built with. Keys are
    /// <see cref="NormalizeFullPath"/> spellings, so one file has one key.
    /// </summary>
    public static StringComparer Comparer { get; } = StringComparer.FromComparison(Comparison);

    /// <summary>The directory holding <paramref name="path"/>; empty for a bare name or a root.</summary>
    public static string DirectoryOf(string path)
    {
        return Path.GetDirectoryName(Portable(path)) ?? string.Empty;
    }

    /// <summary>The file name of <paramref name="path"/>, extension included.</summary>
    public static string NameOf(string path)
    {
        return Path.GetFileName(Portable(path));
    }

    /// <summary>The file name of <paramref name="path"/> without its extension.</summary>
    public static string StemOf(string path)
    {
        return Path.GetFileNameWithoutExtension(Portable(path));
    }

    /// <summary>The extension of <paramref name="path"/>, dot included; empty when it has none.</summary>
    public static string ExtensionOf(string path)
    {
        return Path.GetExtension(Portable(path));
    }

    /// <summary>
    /// <paramref name="segments"/> joined under <paramref name="baseDirectory"/>, fully
    /// qualified and normalized: <c>..</c> segments collapse and separators unify. A
    /// rooted segment starts over, so an absolute path resolves to its own normal form.
    /// </summary>
    public static string Resolve(string baseDirectory, params string[] segments)
    {
        return NormalizeFullPath(Path.Combine([Portable(baseDirectory), .. segments.Select(Portable)]));
    }

    /// <summary><paramref name="segments"/> resolved under the user's temporary directory.</summary>
    public static string Temp(params string[] segments)
    {
        return Resolve(Path.GetTempPath(), segments);
    }

    /// <summary>
    /// <paramref name="path"/> spelled with forward slashes: how solution files and NuGet
    /// assets write a relative path on every platform.
    /// </summary>
    public static string Slashed(string path)
    {
        return path.Replace('\\', '/');
    }

    /// <summary>
    /// <paramref name="path"/> with the platform's separator throughout: MSBuild project
    /// files, solution files and NuGet assets spell a relative path with either slash on
    /// every platform, and .NET on Unix splits on the forward slash alone.
    /// </summary>
    private static string Portable(string path)
    {
        return path.Replace('\\', Path.DirectorySeparatorChar).Replace('/', Path.DirectorySeparatorChar);
    }

    /// <summary>Whether <paramref name="path"/> ends in <paramref name="extension"/> (dot included), by the case rule.</summary>
    public static bool HasExtension(string path, string extension)
    {
        return path.EndsWith(extension, Comparison);
    }

    /// <summary>Whether two paths carry the same file name by the case rule, whatever their directories.</summary>
    public static bool SameName(string left, string right)
    {
        return string.Equals(NameOf(left), NameOf(right), Comparison);
    }

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
    /// Path identity after normalization, by the case rule. <c>null</c>
    /// (e.g. Roslyn documents without a file path) never matches.
    /// </summary>
    public static bool AreEqual(string? left, string? right)
    {
        return left is not null
            && right is not null
            && string.Equals(NormalizeFullPath(left), NormalizeFullPath(right), Comparison);
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
