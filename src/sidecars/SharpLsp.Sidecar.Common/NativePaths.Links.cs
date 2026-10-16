using System.Collections.Concurrent;

namespace SharpLsp.Sidecar.Common;

/// <summary>
/// Path identity through links. Each resolved segment is memoized for
/// <see cref="ResolvedLifetime"/>, so a hash or comparison is a dictionary hit instead of a
/// probe per segment, and a plain entry later replaced by a link is followed once its memo
/// expires. A directory link is memoized like any other segment, so a retargeted one, and every
/// path beneath it, is followed within that lifetime. A file link is never memoized: retargeting
/// it is observed on the next call. Implements [SHARPLSP-ARCHITECTURE-PATHS].
/// </summary>
public static partial class NativePaths
{
    /// <summary>How long a resolved segment is trusted before the disk is asked again.</summary>
    internal static readonly TimeSpan ResolvedLifetime = TimeSpan.FromSeconds(1);

    /// <summary>The most segments kept; the memo starts over when it fills.</summary>
    private const int ResolvedCapacity = 1 << 16;

    internal static readonly ConcurrentDictionary<
        string,
        (string Path, long Expires)
    > ResolvedSegments = new(StringComparer.Ordinal);

    /// <summary>
    /// The comparer every path-keyed collection is built with. Identity resolves links;
    /// retained path strings preserve the spelling the editor opened.
    /// </summary>
    public static StringComparer Comparer { get; } = new LinkComparer();

    /// <summary>
    /// Path spellings by the case rule, links untouched: for ordering output and comparing
    /// names, never for identity.
    /// </summary>
    public static StringComparer SpellingComparer { get; } =
        StringComparer.FromComparison(Comparison);

    private sealed class LinkComparer : StringComparer
    {
        public override int Compare(string? x, string? y)
        {
            return string.Equals(x, y, StringComparison.Ordinal)
                ? 0
                : SpellingComparer.Compare(Canonical(x), Canonical(y));
        }

        public override bool Equals(string? x, string? y)
        {
            return Compare(x, y) == 0;
        }

        public override int GetHashCode(string obj)
        {
            return SpellingComparer.GetHashCode(WithLinksResolved(obj));
        }

        private static string? Canonical(string? path)
        {
            return path is null ? null : WithLinksResolved(path);
        }
    }

    /// <summary>
    /// <paramref name="path"/> fully qualified with every symlinked segment resolved, as editors
    /// hand out both spellings of a linked file, on Windows as well as Unix. Missing outputs
    /// keep their suffix under the resolved ancestor. Implements [SHARPLSP-ARCHITECTURE-PATHS].
    /// </summary>
    public static string WithLinksResolved(string path)
    {
        return
            ResolvedSegments.TryGetValue(path, out var known)
            && known.Expires > Environment.TickCount64
            ? known.Path
            : Probe(path);
    }

    private static string Probe(string path)
    {
        var fullPath = NormalizeFullPath(path);
        try
        {
            var (resolved, fileLink) = ResolveLastSegment(fullPath);
            return fileLink ? resolved : Remember(path, resolved);
        }
        catch (Exception error)
            when (error
                    is IOException
                        or UnauthorizedAccessException
                        or ArgumentException
                        or NotSupportedException
            )
        {
            return fullPath;
        }
    }

    /// <summary>
    /// <paramref name="fullPath"/> under its resolved parent, its last segment followed when
    /// that segment is a link, and whether it was a file link.
    /// </summary>
    private static (string Path, bool FileLink) ResolveLastSegment(string fullPath)
    {
        var trimmed = Path.TrimEndingDirectorySeparator(fullPath);
        var parent = Path.GetDirectoryName(trimmed);
        if (parent is null)
        {
            return (trimmed, false);
        }

        var current = Path.Combine(WithLinksResolved(parent), Path.GetFileName(trimmed));
        return LinkTarget(current) is ({ } target, var fileLink)
            ? (StripVerbatim(target), fileLink)
            : (current, false);
    }

    /// <summary>
    /// Where <paramref name="current"/> finally leads when it is a link, and whether it links a
    /// file; null for a plain or missing entry.
    /// </summary>
    private static (string Target, bool FileLink)? LinkTarget(string current)
    {
        FileSystemInfo entry = new FileInfo(current);
        var attributes = entry.Attributes;
        if (attributes == (FileAttributes)(-1) || !attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            return null;
        }

        var directory = attributes.HasFlag(FileAttributes.Directory);
        entry = directory ? new DirectoryInfo(current) : entry;
        return entry.ResolveLinkTarget(returnFinalTarget: true)?.FullName is { } target
            ? (target, !directory)
            : null;
    }

    /// <summary>Memoize a fully qualified <paramref name="path"/>; a relative one depends on the working directory.</summary>
    private static string Remember(string path, string resolved)
    {
        if (!Path.IsPathFullyQualified(path))
        {
            return resolved;
        }

        if (ResolvedSegments.Count >= ResolvedCapacity)
        {
            ResolvedSegments.Clear();
        }

        ResolvedSegments[path] = (
            resolved,
            Environment.TickCount64 + (long)ResolvedLifetime.TotalMilliseconds
        );
        return resolved;
    }
}
