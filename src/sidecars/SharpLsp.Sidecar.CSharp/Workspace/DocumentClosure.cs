using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>One source file in a file-based app or script closure.</summary>
internal sealed record ClosureFile(string Path, string Text, bool IsRoot);

internal sealed record PackageRef(string Name, string? Version);

/// <summary>
/// Unsaved editor text for one file, standing in for what is on disk while the closure is
/// expanded. The edited file is not necessarily the closure root — an <c>#:include</c>d file
/// can carry directives too — so the override is keyed by path. Implements [SCRIPT-RELOAD].
/// </summary>
internal sealed record LiveText(string Path, string Text);

/// <summary>Result of expanding a closure: the files, plus any non-fatal problems.</summary>
internal sealed record Closure(
    IReadOnlyList<ClosureFile> Files,
    IReadOnlyList<PackageRef> Packages,
    IReadOnlyList<FileDirective> Directives,
    IReadOnlyList<string> Issues
);

/// <summary>
/// Expands the compilation closure of a project-less document. Implements [SCRIPT-CLOSURE].
/// </summary>
/// <remarks>
/// The closure is derived from the ROOT FILE, never from its directory. Globbing a directory
/// compiles unrelated programs together and produces phantom duplicate-entry-point and
/// duplicate-type errors — see [SCRIPT-ANTIPATTERN].
/// </remarks>
internal static class DocumentClosure
{
    // Bounds so a pathological `#:include **/*.cs` cannot hang the sidecar. [SCRIPT-CLOSURE]
    private const int MaxFiles = 64;
    private const int MaxDepth = 8;

    /// <summary>Expand a C# file-based app closure: root file plus transitive <c>#:include</c>.</summary>
    public static Task<Closure> ExpandFileBasedAsync(
        string rootPath,
        LiveText? live,
        CancellationToken ct
    )
    {
        return ExpandAsync(rootPath, live, IncludedPaths, ct);
    }

    /// <summary>
    /// A script closure is the root file alone. Roslyn resolves <c>#load</c> itself through the
    /// compilation's <c>SourceReferenceResolver</c>; adding the loaded files as documents too
    /// would compile them twice. Implements [SCRIPT-CSX-RESOLVERS].
    /// </summary>
    public static Task<Closure> ExpandScriptAsync(
        string rootPath,
        LiveText? live,
        CancellationToken ct
    )
    {
        return ExpandAsync(rootPath, live, NoChildren, ct);
    }

    private static IEnumerable<string> NoChildren(
        IReadOnlyList<FileDirective> directives,
        string filePath,
        ExpansionState state
    )
    {
        return [];
    }

    private static async Task<Closure> ExpandAsync(
        string rootPath,
        LiveText? live,
        ChildResolver children,
        CancellationToken ct
    )
    {
        var state = new ExpansionState(children, live);
        await VisitAsync(rootPath, isRoot: true, depth: 0, state, ct).ConfigureAwait(false);
        return new Closure(state.Files, state.Packages, state.Directives, state.Issues);
    }

    private delegate IEnumerable<string> ChildResolver(
        IReadOnlyList<FileDirective> directives,
        string filePath,
        ExpansionState state
    );

    private static async Task VisitAsync(
        string path,
        bool isRoot,
        int depth,
        ExpansionState state,
        CancellationToken ct
    )
    {
        var full = Path.GetFullPath(path);
        if (!state.Visited.Add(full) || state.Files.Count >= MaxFiles || depth > MaxDepth)
        {
            RecordBound(full, depth, state);
            return;
        }

        var read = state.LiveTextFor(full) ?? await ReadAsync(full, ct).ConfigureAwait(false);

        if (read is null)
        {
            state.Issues.Add($"Could not read '{full}'; it was excluded from the closure.");
            return;
        }

        state.Files.Add(new ClosureFile(full, read, isRoot));

        var tree = CSharpSyntaxTree.ParseText(
            read,
            FileBasedParseOptions,
            path: full,
            cancellationToken: ct
        );
        var root = await tree.GetRootAsync(ct).ConfigureAwait(false);
        var directives = FileLevelDirectives
            .Parse(root)
            .Where(directive => directive.IsValidPlacement)
            .ToArray();
        state.Directives.AddRange(directives);

        foreach (var directive in directives)
        {
            if (
                directive.Kind == FileDirectiveKind.Package
                && !string.IsNullOrEmpty(directive.Name)
            )
            {
                state.Packages.Add(new PackageRef(directive.Name, directive.Value));
            }
        }

        foreach (var child in state.Children(directives, full, state))
        {
            await VisitAsync(child, isRoot: false, depth + 1, state, ct).ConfigureAwait(false);
        }
    }

    private static void RecordBound(string full, int depth, ExpansionState state)
    {
        if (state.Files.Count >= MaxFiles)
        {
            state.Issues.Add(
                $"Closure exceeded {MaxFiles} files; '{full}' and later includes were skipped."
            );
        }
        else if (depth > MaxDepth)
        {
            state.Issues.Add(
                $"Closure exceeded {MaxDepth} levels of #:include nesting at '{full}'."
            );
        }
    }

    // The FileBasedProgram feature flag makes Roslyn lex `#:` as IgnoredDirectiveTrivia in a
    // Regular compilation, matching what the SDK passes to csc. [SCRIPT-FILEBASED-DIRECTIVES]
    private static readonly CSharpParseOptions FileBasedParseOptions = new CSharpParseOptions(
        LanguageVersion.Latest
    ).WithFeatures([new KeyValuePair<string, string>("FileBasedProgram", "true")]);

    private static IEnumerable<string> IncludedPaths(
        IReadOnlyList<FileDirective> directives,
        string filePath,
        ExpansionState state
    )
    {
        var baseDir = Path.GetDirectoryName(filePath) ?? ".";
        return directives
            .Where(d => d.Kind == FileDirectiveKind.Include)
            .SelectMany(d => ResolveInclude(d.Name, baseDir, state));
    }

    // `#:include` accepts a literal path, a glob, or an MSBuild property. Property expansion
    // requires a real MSBuild evaluation and is deferred to [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
    private static string[] ResolveInclude(string pattern, string baseDir, ExpansionState state)
    {
        var usesMsBuildProperty = pattern.Contains("$(", StringComparison.Ordinal);
        if (usesMsBuildProperty)
        {
            state.Issues.Add(
                $"#:include '{pattern}' uses an MSBuild property, which is not yet expanded."
            );
        }

        var isGlob =
            pattern.Contains('*', StringComparison.Ordinal)
            || pattern.Contains('?', StringComparison.Ordinal);
        return usesMsBuildProperty ? []
            : isGlob ? ExpandGlob(pattern, baseDir, state)
            : [Path.GetFullPath(Path.Combine(baseDir, pattern))];
    }

    private static string[] ExpandGlob(string pattern, string baseDir, ExpansionState state)
    {
        try
        {
            var recursive = pattern.Contains("**", StringComparison.Ordinal);
            var normalized = pattern
                .Replace("**/", string.Empty, StringComparison.Ordinal)
                .Replace("**\\", string.Empty, StringComparison.Ordinal);
            var dir = Path.GetFullPath(
                Path.Combine(baseDir, Path.GetDirectoryName(normalized) ?? string.Empty)
            );
            var mask = Path.GetFileName(normalized);
            var option = recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
            return Directory.Exists(dir) ? Directory.GetFiles(dir, mask, option) : [];
        }
        catch (Exception ex)
            when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            state.Issues.Add($"#:include '{pattern}' could not be expanded: {ex.Message}");
            return [];
        }
    }

    private static async Task<string?> ReadAsync(string path, CancellationToken ct)
    {
        try
        {
            return await File.ReadAllTextAsync(path, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
            when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }

    private sealed class ExpansionState(ChildResolver children, LiveText? live)
    {
        private readonly string? _livePath = live is null ? null : Path.GetFullPath(live.Path);

        /// <summary>The unsaved text for <paramref name="fullPath"/>, or null to read disk.</summary>
        public string? LiveTextFor(string fullPath)
        {
            return string.Equals(_livePath, fullPath, StringComparison.OrdinalIgnoreCase)
                ? live!.Text
                : null;
        }

        public ChildResolver Children { get; } = children;
        public HashSet<string> Visited { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<ClosureFile> Files { get; } = [];
        public List<PackageRef> Packages { get; } = [];
        public List<FileDirective> Directives { get; } = [];
        public List<string> Issues { get; } = [];
    }
}
