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
        return Resolve(path).Path;
    }

    /// <summary>
    /// Observes each disk probe, so tests can count that lookups hit the memo instead of the
    /// disk (GitHub #358) and that a missing path is asked about once. Null outside those tests.
    /// </summary>
    internal static Action<string>? Probed { get; set; }

    /// <summary>A resolved path, and whether its entry is known to be missing.</summary>
    private readonly record struct Resolved(string Path, bool Missing);

    /// <summary><paramref name="path"/> resolved: a memoized entry exists, any other is probed.</summary>
    private static Resolved Resolve(string path)
    {
        return
            ResolvedSegments.TryGetValue(path, out var known)
            && known.Expires > Environment.TickCount64
            ? new(known.Path, Missing: false)
            : Probe(path);
    }

    /// <summary>
    /// Asks the disk about <paramref name="path"/>. An existing entry other than a file link is
    /// memoized; a missing one never is, as a link may be created there before expiry.
    /// </summary>
    private static Resolved Probe(string path)
    {
        var fullPath = NormalizeFullPath(path);
        try
        {
            var (resolved, fileLink) = ResolveLastSegment(fullPath);
            return resolved.Missing || fileLink
                ? resolved
                : resolved with
                {
                    Path = Remember(path, resolved.Path),
                };
        }
        catch (Exception error)
            when (error
                    is IOException
                        or UnauthorizedAccessException
                        or ArgumentException
                        or NotSupportedException
            )
        {
            return new(fullPath, Missing: false);
        }
    }

    /// <summary>
    /// <paramref name="fullPath"/> under its resolved parent, its last segment followed when
    /// that segment is a link, and whether it was a file link. Nothing exists beneath a missing
    /// parent, so a missing path costs one probe however many of its segments are missing.
    /// </summary>
    private static (Resolved Entry, bool FileLink) ResolveLastSegment(string fullPath)
    {
        var trimmed = Path.TrimEndingDirectorySeparator(fullPath);
        var parent = Path.GetDirectoryName(trimmed);
        if (parent is null)
        {
            return (new(trimmed, Missing: false), false);
        }

        var (resolvedParent, parentMissing) = Resolve(parent);
        var current = Path.Combine(resolvedParent, Path.GetFileName(trimmed));
        return parentMissing ? (new(current, Missing: true), false) : Entry(current);
    }

    /// <summary>
    /// The entry at <paramref name="current"/> from one attribute read: followed when it is a
    /// link, missing when there is none or its link leads nowhere, and whether it links a file.
    /// </summary>
    private static (Resolved Entry, bool FileLink) Entry(string current)
    {
        Probed?.Invoke(current);
        FileSystemInfo entry = new FileInfo(current);
        var attributes = entry.Attributes;
        var missing = attributes == (FileAttributes)(-1);
        if (missing || !attributes.HasFlag(FileAttributes.ReparsePoint))
        {
            return (new(current, missing), false);
        }

        var directory = attributes.HasFlag(FileAttributes.Directory);
        entry = directory ? new DirectoryInfo(current) : entry;
        return entry.ResolveLinkTarget(returnFinalTarget: true) is { } target
            ? (new(StripVerbatim(target.FullName), !target.Exists), !directory)
            : (new(current, Missing: false), false);
    }

    /// <summary>Memoize an absolute path; a relative one depends on the working directory.</summary>
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
