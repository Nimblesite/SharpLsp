using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>One source file in a file-based app or script closure.</summary>
internal sealed record ClosureFile(string Path, string Text, bool IsRoot);

/// <summary>Result of expanding a closure: the files, plus any non-fatal problems.</summary>
internal sealed record Closure(IReadOnlyList<ClosureFile> Files, IReadOnlyList<string> Issues);

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
    public static Task<Closure> ExpandFileBasedAsync(string rootPath, CancellationToken ct)
    {
        return ExpandAsync(rootPath, IncludedPaths, ct);
    }

    /// <summary>
    /// A script closure is the root file alone. Roslyn resolves <c>#load</c> itself through the
    /// compilation's <c>SourceReferenceResolver</c>; adding the loaded files as documents too
    /// would compile them twice. Implements [SCRIPT-CSX-RESOLVERS].
    /// </summary>
    public static Task<Closure> ExpandScriptAsync(string rootPath, CancellationToken ct)
    {
        return ExpandAsync(rootPath, NoChildren, ct);
    }

    private static IEnumerable<string> NoChildren(
        string text,
        string filePath,
        ExpansionState state
    )
    {
        return [];
    }

    private static async Task<Closure> ExpandAsync(
        string rootPath,
        ChildResolver children,
        CancellationToken ct
    )
    {
        var state = new ExpansionState(children);
        await VisitAsync(rootPath, isRoot: true, depth: 0, state, ct).ConfigureAwait(false);
        return new Closure(state.Files, state.Issues);
    }

    private delegate IEnumerable<string> ChildResolver(
        string text,
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

        var read = await ReadAsync(full, ct).ConfigureAwait(false);
        if (read is null)
        {
            state.Issues.Add($"Could not read '{full}'; it was excluded from the closure.");
            return;
        }

        state.Files.Add(new ClosureFile(full, read, isRoot));
        foreach (var child in state.Children(read, full, state))
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
        string text,
        string filePath,
        ExpansionState state
    )
    {
        var tree = CSharpSyntaxTree.ParseText(text, FileBasedParseOptions, path: filePath);
        var directives = FileLevelDirectives.Parse(tree.GetRoot());
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

    private sealed class ExpansionState(ChildResolver children)
    {
        public ChildResolver Children { get; } = children;
        public HashSet<string> Visited { get; } = new(StringComparer.OrdinalIgnoreCase);
        public List<ClosureFile> Files { get; } = [];
        public List<string> Issues { get; } = [];
    }
}
