using System.Collections.Concurrent;
using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Where a project-wide query looks: each project's ACTIVE framework. Every other framework's
/// copy of a project holds the same files again, so searching it would report one use once per
/// framework, and compile every framework to find it. Null sets search the whole solution, which
/// is the same thing when no project is multi-targeted. Implements [NETFX-PROJECTS-CSHARP].
/// </summary>
internal sealed record SearchScope(
    Solution Solution,
    IImmutableSet<Project>? Projects,
    IImmutableSet<Document>? Documents
)
{
    /// <summary>
    /// The active frameworks of the solution <paramref name="document"/> belongs to: every
    /// document of theirs, the ones their source generators produce included.
    /// </summary>
    internal static async Task<SearchScope> OfAsync(
        Document document,
        ConcurrentDictionary<string, string> chosen,
        CancellationToken ct
    )
    {
        var solution = document.Project.Solution;
        var active = solution
            .Projects.Where(project => TargetFrameworks.IsActive(solution, project, chosen))
            .ToImmutableHashSet();
        if (active.Count == solution.ProjectIds.Count)
        {
            return new SearchScope(solution, null, null);
        }

        var generated = await Task.WhenAll(
                active.Select(project => project.GetSourceGeneratedDocumentsAsync(ct).AsTask())
            )
            .ConfigureAwait(false);
        return new SearchScope(
            solution,
            active,
            [
                .. active
                    .SelectMany(project => project.Documents)
                    .Concat(generated.SelectMany(documents => documents)),
            ]
        );
    }

    /// <summary>
    /// Every use of <paramref name="symbol"/> in scope. Roslyn follows the symbol into each
    /// framework's copy of its project itself, so a project in scope that compiles against
    /// another framework's build of it is still searched.
    /// </summary>
    internal Task<IEnumerable<ReferencedSymbol>> FindReferencesAsync(
        ISymbol symbol,
        CancellationToken ct
    )
    {
        return SymbolFinder.FindReferencesAsync(symbol, Solution, Documents, ct);
    }

    /// <summary>
    /// The distinct places <paramref name="references"/> were found: a property read is a read
    /// of its getter too, and one place is one use.
    /// </summary>
    internal static IEnumerable<Location> DistinctLocations(
        IEnumerable<ReferencedSymbol> references
    )
    {
        return references
            .SelectMany(reference => reference.Locations)
            .Select(reference => reference.Location)
            .DistinctBy(PlaceOf);
    }

    /// <summary>Every implementation of <paramref name="symbol"/> in scope, each once.</summary>
    internal Task<List<ISymbol>> FindImplementationsAsync(ISymbol symbol, CancellationToken ct)
    {
        return AcrossFrameworksAsync(
            symbol,
            copy => SymbolFinder.FindImplementationsAsync(copy, Solution, Projects, ct),
            ct
        );
    }

    /// <summary>Every class in scope deriving from <paramref name="type"/>, each once.</summary>
    internal async Task<List<INamedTypeSymbol>> FindDerivedClassesAsync(
        INamedTypeSymbol type,
        CancellationToken ct
    )
    {
        var derived = await AcrossFrameworksAsync<INamedTypeSymbol>(
                type,
                async copy =>
                    copy is INamedTypeSymbol copyType
                        ? await SymbolFinder
                            .FindDerivedClassesAsync(copyType, Solution, true, Projects, ct)
                            .ConfigureAwait(false)
                        : [],
                ct
            )
            .ConfigureAwait(false);
        return [.. derived.OfType<INamedTypeSymbol>()];
    }

    /// <summary>
    /// Every call in scope of <paramref name="symbol"/> or of its copy in another framework's
    /// build — which Roslyn reports as indirect — but never a call of an override.
    /// </summary>
    internal async Task<List<SymbolCallerInfo>> FindCallersAsync(
        ISymbol symbol,
        CancellationToken ct
    )
    {
        var copies = await CopiesAsync(symbol, ct).ConfigureAwait(false);
        var callers = await SymbolFinder
            .FindCallersAsync(symbol, Solution, Documents, ct)
            .ConfigureAwait(false);
        return
        [
            .. callers.Where(caller =>
                caller.IsDirect
                || copies.Contains(caller.CalledSymbol, SymbolEqualityComparer.Default)
            ),
        ];
    }

    /// <summary>
    /// <paramref name="search"/> run for <paramref name="symbol"/>'s copy in EVERY framework, each
    /// result once: a project in scope sees the copy of the framework it compiles against, which
    /// need not be the one the symbol was resolved in.
    /// </summary>
    private async Task<List<ISymbol>> AcrossFrameworksAsync<TFound>(
        ISymbol symbol,
        Func<ISymbol, Task<IEnumerable<TFound>>> search,
        CancellationToken ct
    )
        where TFound : ISymbol
    {
        var found = new List<ISymbol>();
        foreach (var copy in await CopiesAsync(symbol, ct).ConfigureAwait(false))
        {
            found.AddRange((await search(copy).ConfigureAwait(false)).Cast<ISymbol>());
        }

        return [.. found.DistinctBy(SymbolPlaceOf)];
    }

    /// <summary>
    /// <paramref name="symbol"/> in every framework's build of the project declaring it. With no
    /// project multi-targeted, and for a symbol with no source, that is the symbol alone.
    /// </summary>
    private async Task<List<ISymbol>> CopiesAsync(ISymbol symbol, CancellationToken ct)
    {
        var copies = new List<ISymbol> { symbol };
        var file = symbol
            .Locations.FirstOrDefault(location => location.IsInSource)
            ?.SourceTree?.FilePath;
        if (Projects is null || file is null)
        {
            return copies;
        }

        foreach (var id in Solution.GetDocumentIdsWithFilePath(file))
        {
            var project = Solution.GetProject(id.ProjectId);
            var compilation = project is null
                ? null
                : await project.GetCompilationAsync(ct).ConfigureAwait(false);
            copies.AddRange(
                compilation is null ? [] : SymbolFinder.FindSimilarSymbols(symbol, compilation, ct)
            );
        }

        return [.. copies.Distinct(SymbolEqualityComparer.Default)];
    }

    /// <summary>A symbol's identity for de-duplication: where it is declared, else its name.</summary>
    private static object SymbolPlaceOf(ISymbol symbol)
    {
        return symbol.Locations.FirstOrDefault(location => location.IsInSource) is { } source
            ? PlaceOf(source)
            : symbol.ToDisplayString();
    }

    /// <summary>A source location's file and span: the same in every framework's copy.</summary>
    private static (string? File, TextSpan Span) PlaceOf(Location location)
    {
        return (location.SourceTree?.FilePath, location.SourceSpan);
    }
}
