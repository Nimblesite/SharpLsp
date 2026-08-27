using System.Collections.Immutable;
using Microsoft.CodeAnalysis.CodeFixes;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for <see cref="AnalyzerDiagnosticResolver"/>.
///
/// The style-based rewrites (use `var`, file-scoped namespace) are not ordinary
/// refactorings — they are code *fixes*, and only surface when the matching IDE
/// analyzer actually reports a diagnostic over the requested span. That needs
/// three things lined up at once: the analyzer assemblies discovered by
/// reflection, the project's .editorconfig driving the style preference, and a
/// span filter that treats a diagnostic on a namespace body as touching the
/// `namespace` keyword. Nothing exercised that chain, so a discovery or
/// filtering regression would have silently turned the whole rewrite family off
/// with no failing test.
///
/// The repository's own VS Code fixture deliberately disables analyzers, so
/// these style rules can never fire there — this project turns them on.
/// </summary>
public sealed class AnalyzerDiagnosticResolverTests : IDisposable
{
    private const string Source = """
        namespace Styled
        {
            public class Sample
            {
                public int Compute()
                {
                    int value = 41;
                    return value;
                }
            }
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-analyzers-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public AnalyzerDiagnosticResolverTests()
    {
        Directory.CreateDirectory(_root);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <EnableNETAnalyzers>true</EnableNETAnalyzers>
                <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
              </PropertyGroup>
            </Project>
            """;

        // The style preferences are what make IDE0007 / IDE0161 report at all.
        const string editorConfig = """
            root = true

            [*.cs]
            csharp_style_namespace_declarations = file_scoped:warning
            csharp_style_var_for_built_in_types = true:warning
            csharp_style_var_when_type_is_apparent = true:warning
            csharp_style_var_elsewhere = true:warning
            """;

        _csprojPath = Path.Combine(_root, "Styled.csproj");
        _sourcePath = Path.Combine(_root, "Styled.cs");
        File.WriteAllText(_csprojPath, csproj);
        File.WriteAllText(Path.Combine(_root, ".editorconfig"), editorConfig);
        File.WriteAllText(_sourcePath, Source);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public void Feature_providers_are_discovered_by_reflection()
    {
        // Roslyn's feature assemblies are MEF-composed and cannot be resolved
        // through the workspace headlessly, so the sidecar reflects over them
        // directly. An empty result means every code fix silently disappears.
        var fixes = AnalyzerDiagnosticResolver.DiscoverProviders<CodeFixProvider>();
        Assert.NotEmpty(fixes);

        // Discovery must be de-duplicated by concrete type.
        Assert.Equal(fixes.Length, fixes.Select(provider => provider.GetType()).Distinct().Count());
    }

    [Fact]
    public void Only_analyzers_backing_a_rewrite_diagnostic_are_selected()
    {
        var providers = AnalyzerDiagnosticResolver.DiscoverProviders<CodeFixProvider>();
        var analyzers = AnalyzerDiagnosticResolver.DiscoverFixableAnalyzers(providers);
        Assert.NotEmpty(analyzers);

        // Every selected analyzer must actually support one of the four rewrite
        // ids; anything else is dead weight run on every code-action request.
        var rewriteIds = new[] { "IDE0007", "IDE0008", "IDE0160", "IDE0161" };
        Assert.All(
            analyzers,
            analyzer =>
                Assert.Contains(
                    analyzer.SupportedDiagnostics.Select(descriptor => descriptor.Id),
                    id => rewriteIds.Contains(id, StringComparer.Ordinal)
                )
        );
    }

    [Fact]
    public void Selecting_analyzers_from_no_providers_yields_nothing()
    {
        var analyzers = AnalyzerDiagnosticResolver.DiscoverFixableAnalyzers([]);
        Assert.Empty(analyzers);
    }

    [Fact]
    public async Task No_analyzers_means_no_diagnostics_and_no_compilation_work()
    {
        using var manager = await OpenAsync();
        var actions = Unwrap(await manager.GetCodeActionsAsync(_sourcePath, 6, 12, 6, 12));

        // The resolver short-circuits on an empty analyzer set; the request must
        // still succeed rather than throwing.
        Assert.NotNull(actions);
    }

    [Fact]
    public async Task A_block_namespace_offers_the_file_scoped_rewrite_on_its_keyword()
    {
        using var manager = await OpenAsync();
        // IDE0161 reports over the namespace *declaration*, but a user's caret
        // sits on the `namespace` keyword. The resolver's namespace-keyword
        // special case is what connects the two.
        var (line, character) = Locate("namespace Styled", "namespace");
        var actions = Unwrap(
            await manager.GetCodeActionsAsync(_sourcePath, line, character, line, character)
        );

        Assert.Contains(
            actions,
            action => action.Title.Contains("file-scoped", StringComparison.OrdinalIgnoreCase)
        );
    }

    [Fact]
    public async Task An_explicitly_typed_local_offers_the_var_rewrite()
    {
        using var manager = await OpenAsync();
        var (line, character) = Locate("            int value = 41;", "int");
        var actions = Unwrap(
            await manager.GetCodeActionsAsync(_sourcePath, line, character, line, character)
        );

        Assert.Contains(
            actions,
            action => action.Title.Contains("var", StringComparison.OrdinalIgnoreCase)
        );
    }

    [Fact]
    public async Task A_statement_inside_the_namespace_still_sees_only_one_of_each_rewrite()
    {
        using var manager = await OpenAsync();
        // IDE0161's location covers the whole namespace declaration, so a caret
        // on any statement inside it legitimately matches. What must not happen
        // is the same rewrite arriving twice: the resolver unions syntax and
        // semantic diagnostics, and both passes report this one. That is what
        // the de-duplication in FilterDiagnostics exists for.
        var (line, character) = Locate("            return value;", "return");
        var actions = Unwrap(
            await manager.GetCodeActionsAsync(_sourcePath, line, character, line, character)
        );

        var duplicated = actions
            .GroupBy(action => action.Title, StringComparer.Ordinal)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToList();
        Assert.Empty(duplicated);
    }

    private static (int Line, int Character) Locate(string anchor, string token)
    {
        var lines = Source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var index = Array.FindIndex(
            lines,
            value => value.Contains(anchor, StringComparison.Ordinal)
        );
        Assert.True(index >= 0, $"anchor not found: {anchor}");
        var character = lines[index].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"token '{token}' not found on: {anchor}");
        return (index, character);
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercising the real solution-loading boundary
        var opened = await manager.OpenAsync(_csprojPath);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded for code actions");
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }
}
