using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeFixes;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using Serilog;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Discovers Roslyn feature components and runs the style analyzers needed by code fixes.
/// Project analyzer options carry the effective .editorconfig configuration.
/// </summary>
internal static class AnalyzerDiagnosticResolver
{
    private static readonly ImmutableHashSet<string> RewriteDiagnosticIds = ImmutableHashSet.Create(
        StringComparer.Ordinal,
        "IDE0007",
        "IDE0008",
        "IDE0160",
        "IDE0161"
    );

    private static readonly ImmutableArray<string> FeatureAssemblyNames =
    [
        "Microsoft.CodeAnalysis.Features",
        "Microsoft.CodeAnalysis.CSharp.Features",
    ];

    public static async Task<ImmutableArray<Diagnostic>> ResolveAsync(
        Document document,
        SemanticModel model,
        TextSpan span,
        ImmutableArray<DiagnosticAnalyzer> analyzers,
        CancellationToken ct
    )
    {
        return analyzers.IsDefaultOrEmpty
            ? []
            : await ResolveWithCompilationAsync(document, model, span, analyzers, ct)
                .ConfigureAwait(false);
    }

    public static ImmutableArray<DiagnosticAnalyzer> DiscoverFixableAnalyzers(
        ImmutableArray<CodeFixProvider> providers
    )
    {
        var fixableIds = providers
            .SelectMany(provider => provider.FixableDiagnosticIds)
            .Where(RewriteDiagnosticIds.Contains)
            .ToImmutableHashSet(StringComparer.Ordinal);
        return
        [
            .. DiscoverProviders<DiagnosticAnalyzer>()
                .Where(analyzer => SupportsAny(analyzer, fixableIds))
                .DistinctBy(analyzer => analyzer.GetType()),
        ];
    }

    public static ImmutableArray<T> DiscoverProviders<T>()
        where T : class
    {
        var providers = GetFeatureAssemblies()
            .SelectMany(GetLoadableTypes)
            .Select(TryInstantiate<T>)
            .OfType<T>()
            .DistinctBy(provider => provider.GetType())
            .ToImmutableArray();
        Log.Debug(
            "[CodeAction] Discovered {Count} {ProviderType} providers",
            providers.Length,
            typeof(T).Name
        );
        return providers;
    }

    private static async Task<ImmutableArray<Diagnostic>> ResolveWithCompilationAsync(
        Document document,
        SemanticModel model,
        TextSpan span,
        ImmutableArray<DiagnosticAnalyzer> analyzers,
        CancellationToken ct
    )
    {
        var compilation = await document.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        if (compilation is null)
        {
            return [];
        }

        var runner = compilation.WithAnalyzers(analyzers, CreateOptions(document.Project));
        return await ResolveForSpanAsync(runner, model, span, ct).ConfigureAwait(false);
    }

    private static CompilationWithAnalyzersOptions CreateOptions(Project project)
    {
        return new CompilationWithAnalyzersOptions(
            project.AnalyzerOptions,
            LogAnalyzerFailure,
            concurrentAnalysis: true,
            logAnalyzerExecutionTime: false,
            reportSuppressedDiagnostics: false
        );
    }

    private static async Task<ImmutableArray<Diagnostic>> ResolveForSpanAsync(
        CompilationWithAnalyzers runner,
        SemanticModel model,
        TextSpan span,
        CancellationToken ct
    )
    {
        var syntax = await runner
            .GetAnalyzerSyntaxDiagnosticsAsync(model.SyntaxTree, span, ct)
            .ConfigureAwait(false);
        var semantic = await runner
            .GetAnalyzerSemanticDiagnosticsAsync(model, span, ct)
            .ConfigureAwait(false);
        return FilterDiagnostics(syntax.AddRange(semantic), model.SyntaxTree, span);
    }

    private static ImmutableArray<Diagnostic> FilterDiagnostics(
        ImmutableArray<Diagnostic> diagnostics,
        SyntaxTree tree,
        TextSpan span
    )
    {
        return
        [
            .. diagnostics
                .Where(diagnostic => MatchesSpan(diagnostic, tree, span))
                .DistinctBy(DiagnosticKey),
        ];
    }

    private static bool MatchesSpan(Diagnostic diagnostic, SyntaxTree tree, TextSpan span)
    {
        return DiagnosticLocations(diagnostic)
                .Any(location => MatchesLocation(location, tree, span))
            || (
                IsNamespaceStyle(diagnostic.Id)
                && DiagnosticLocations(diagnostic)
                    .Any(location => MatchesNamespaceKeyword(location, tree, span))
            );
    }

    private static IEnumerable<Location> DiagnosticLocations(Diagnostic diagnostic)
    {
        yield return diagnostic.Location;
        foreach (var location in diagnostic.AdditionalLocations)
        {
            yield return location;
        }
    }

    private static bool MatchesLocation(Location location, SyntaxTree tree, TextSpan requested)
    {
        return ReferenceEquals(location.SourceTree, tree)
            && SpansTouch(location.SourceSpan, requested);
    }

    private static bool MatchesNamespaceKeyword(
        Location location,
        SyntaxTree tree,
        TextSpan requested
    )
    {
        if (!ReferenceEquals(location.SourceTree, tree))
        {
            return false;
        }

        var declaration = FindNamespaceDeclaration(tree, location.SourceSpan);
        return declaration is not null && SpansTouch(declaration.NamespaceKeyword.Span, requested);
    }

    private static BaseNamespaceDeclarationSyntax? FindNamespaceDeclaration(
        SyntaxTree tree,
        TextSpan span
    )
    {
        var node = tree.GetRoot().FindNode(span, getInnermostNodeForTie: true);
        return node.AncestorsAndSelf().OfType<BaseNamespaceDeclarationSyntax>().FirstOrDefault();
    }

    private static bool SpansTouch(TextSpan candidate, TextSpan requested)
    {
        return requested.IsEmpty
            ? candidate.Contains(requested.Start) || candidate.Start == requested.Start
            : candidate.IntersectsWith(requested);
    }

    private static bool IsNamespaceStyle(string diagnosticId)
    {
        return diagnosticId is "IDE0160" or "IDE0161";
    }

    private static (string Core, string Properties, string Additional) DiagnosticKey(
        Diagnostic diagnostic
    )
    {
        var core = string.Join(
            "\u001f",
            diagnostic.Id,
            LocationKey(diagnostic.Location),
            diagnostic.Severity,
            diagnostic.GetMessage(CultureInfo.InvariantCulture)
        );
        var properties = string.Join(
            "\u001e",
            diagnostic.Properties.OrderBy(pair => pair.Key).Select(PropertyKey)
        );
        return (
            core,
            properties,
            string.Join("\u001e", diagnostic.AdditionalLocations.Select(LocationKey))
        );
    }

    private static string PropertyKey(KeyValuePair<string, string?> property)
    {
        return $"{property.Key}\u001d{property.Value}";
    }

    private static string LocationKey(Location location)
    {
        return $"{location.SourceTree?.FilePath}\u001d{location.SourceSpan.Start}\u001d{location.SourceSpan.Length}";
    }

    private static bool SupportsAny(
        DiagnosticAnalyzer analyzer,
        ImmutableHashSet<string> fixableIds
    )
    {
        try
        {
            return analyzer.SupportedDiagnostics.Any(descriptor =>
                fixableIds.Contains(descriptor.Id)
            );
        }
        catch (Exception ex)
        {
            Log.Debug(
                ex,
                "[CodeAction] Could not inspect analyzer {Analyzer}",
                analyzer.GetType().Name
            );
            return false;
        }
    }

    private static IEnumerable<System.Reflection.TypeInfo> GetLoadableTypes(Assembly assembly)
    {
        try
        {
            return assembly.DefinedTypes.OrderBy(type => type.FullName, StringComparer.Ordinal);
        }
        catch (ReflectionTypeLoadException ex)
        {
            Log.Debug(
                ex,
                "[CodeAction] Some types in {Assembly} could not load",
                assembly.GetName().Name
            );
            return ex.Types.OfType<Type>().Select(type => type.GetTypeInfo());
        }
    }

    private static T? TryInstantiate<T>(System.Reflection.TypeInfo type)
        where T : class
    {
        if (type.IsAbstract || type.IsInterface || !typeof(T).IsAssignableFrom(type))
        {
            return null;
        }

        try
        {
            return Activator.CreateInstance(type.AsType(), nonPublic: true) as T;
        }
        catch
        {
            return null; // MEF-only feature components are unavailable headlessly.
        }
    }

    private static ImmutableArray<Assembly> GetFeatureAssemblies()
    {
        return [.. FeatureAssemblyNames.Select(TryLoadAssembly).OfType<Assembly>()];
    }

    private static Assembly? TryLoadAssembly(string name)
    {
        try
        {
            return Assembly.Load(name);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "[CodeAction] Feature assembly {Assembly} could not load", name);
            return null;
        }
    }

    private static void LogAnalyzerFailure(
        Exception exception,
        DiagnosticAnalyzer analyzer,
        Diagnostic diagnostic
    )
    {
        Log.Debug(
            exception,
            "[CodeAction] Analyzer {Analyzer} failed while producing {Diagnostic}",
            analyzer.GetType().Name,
            diagnostic.Id
        );
    }
}
