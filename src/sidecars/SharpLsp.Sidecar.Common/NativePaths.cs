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
    public const StringComparison Comparison = StringComparison.OrdinalIgnoreCase;

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
        return NormalizeFullPath(
            Path.Combine([Portable(baseDirectory), .. segments.Select(Portable)])
        );
    }

    /// <summary>
    /// <paramref name="segments"/> joined as written, relative when the first is: how a
    /// project file spells a <c>&lt;ProjectReference&gt;</c> or a solution a project path.
    /// </summary>
    public static string Join(params string[] segments)
    {
        return Path.Combine([.. segments.Select(Portable)]);
    }

    /// <summary><paramref name="path"/> relative to <paramref name="baseDirectory"/>, as a project file spells a reference.</summary>
    public static string RelativeTo(string baseDirectory, string path)
    {
        return Path.GetRelativePath(Portable(baseDirectory), Portable(path));
    }

    /// <summary>Whether <paramref name="path"/> is absolute on this platform.</summary>
    public static bool IsRooted(string path)
    {
        return Path.IsPathRooted(Portable(path));
    }

    /// <summary><paramref name="path"/> with <paramref name="extension"/> (dot included) in place of its own.</summary>
    public static string WithExtension(string path, string extension)
    {
        return Path.ChangeExtension(Portable(path), extension);
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
        return path.Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar);
    }

    /// <summary>Whether <paramref name="path"/> ends in <paramref name="extension"/> (dot included), by the case rule.</summary>
    public static bool HasExtension(string path, string extension)
    {
        return path.EndsWith(extension, Comparison);
    }

    /// <summary>Whether a directory named <paramref name="segment"/> lies on <paramref name="path"/>, by the case rule.</summary>
    public static bool HasDirectory(string path, string segment)
    {
        var separator = Path.DirectorySeparatorChar;
        return Portable(path).Contains($"{separator}{segment}{separator}", Comparison);
    }

    /// <summary>Probed case rules, per directory: whether it tells names apart by case.</summary>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<
        string,
        bool
    > CaseSensitiveDirectories = new(StringComparer.Ordinal);

    /// <summary>
    /// The one identity of <paramref name="path"/>: its <see cref="NormalizeFullPath"/> spelling,
    /// exact in a directory that tells names apart by case and folded in one that does not. Two
    /// names differing only in case are two files in a case-sensitive directory and one elsewhere;
    /// folding everywhere dropped the second of two such files from a closure without a word. A
    /// directory that cannot be probed (the file is missing) keeps every spelling apart, so a
    /// missing file is reported, never merged. The probe is cached per directory.
    /// Implements [SHARPLSP-ARCHITECTURE-PATHS] and [SCRIPT-CLOSURE] (GitHub #190).
    /// </summary>
    public static string IdentityOf(string path)
    {
        var fullPath = NormalizeFullPath(path);
        return TellsCaseApart(fullPath) ? fullPath : fullPath.ToUpperInvariant();
    }

    /// <summary>Whether the directory holding <paramref name="fullPath"/> tells names apart by case; true when it cannot be probed.</summary>
    private static bool TellsCaseApart(string fullPath)
    {
        var directory = DirectoryOf(fullPath) is { Length: > 0 } parent ? parent : fullPath;
        if (CaseSensitiveDirectories.TryGetValue(directory, out var known))
        {
            return known;
        }

        var probed = IsCaseSensitive(fullPath);
        if (probed is { } sensitive)
        {
            CaseSensitiveDirectories[directory] = sensitive;
        }

        return probed ?? true;
    }

    /// <summary>The directories a search-path value such as <c>PATH</c> lists, empty entries dropped.</summary>
    public static string[] SearchPathEntries(string? value)
    {
        return (value ?? string.Empty).Split(
            Path.PathSeparator,
            StringSplitOptions.RemoveEmptyEntries
        );
    }

    /// <summary>The file name of the <paramref name="stem"/> executable on this platform.</summary>
    public static string ExecutableName(string stem)
    {
        return OperatingSystem.IsWindows() ? $"{stem}.exe" : stem;
    }

    /// <summary>
    /// <paramref name="path"/> fully qualified with every symlinked segment resolved, as editors
    /// hand out both spellings of a linked file. Windows keeps the qualified spelling.
    /// </summary>
    public static string WithLinksResolved(string path)
    {
        var fullPath = Path.GetFullPath(path);
        return OperatingSystem.IsWindows() ? fullPath : ResolveLinks(fullPath);
    }

    /// <summary>Resolve each symlinked segment of <paramref name="fullPath"/>.</summary>
    private static string ResolveLinks(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)!;
        var current = root;
        foreach (
            var segment in fullPath[root.Length..]
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
        )
        {
            current = Path.Combine(current, segment);
            FileSystemInfo entry = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (entry.ResolveLinkTarget(returnFinalTarget: true) is { } target)
            {
                current = target.FullName;
            }
        }

        return current;
    }

    /// <summary>
    /// Every character neutralised in a file name built from a display name. The leading literals
    /// are replaced on <em>every</em> platform so the same type yields the same
    /// file name everywhere: <see cref="Path.GetInvalidFileNameChars"/> is
    /// platform-specific — on Unix it is only <c>{ '\0', '/' }</c> — so relying on
    /// it alone would leave <c>&lt;</c>, <c>&gt;</c>, <c>:</c>, <c>,</c> and spaces
    /// intact on Linux while stripping them on Windows.
    /// </summary>
    private static readonly char[] UnsafeNameChars =
    [
        '<',
        '>',
        ':',
        ',',
        ' ',
        .. Path.GetInvalidFileNameChars(),
    ];

    /// <summary><paramref name="name"/> as a file name every platform accepts, one spelling everywhere.</summary>
    public static string SafeName(string name)
    {
        return string.Create(
            name.Length,
            name,
            static (destination, source) =>
            {
                for (var index = 0; index < source.Length; index++)
                {
                    var candidate = source[index];
                    destination[index] =
                        Array.IndexOf(UnsafeNameChars, candidate) >= 0 ? '_' : candidate;
                }
            }
        );
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

    /// <summary>
    /// <paramref name="path"/> with every letter's case flipped: on a directory that does
    /// not tell case apart, a second spelling of the same file.
    /// </summary>
    public static string FlipCase(string path)
    {
        return string.Concat(
            path.Select(letter =>
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
