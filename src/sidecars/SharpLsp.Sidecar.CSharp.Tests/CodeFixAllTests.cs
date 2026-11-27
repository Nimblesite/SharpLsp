using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Fix all at document / project / solution scope for C# fixes
/// ([FIXALL-SCOPES], [FIXALL-TESTS]; GitHub #577): a listed fix whose provider
/// has a <c>FixAllProvider</c> reports its equivalence key and scopes, and the
/// fix-all resolve computes every occurrence in the scope as one workspace
/// edit. Tested against a real two-project solution, never mocks.
/// </summary>
public sealed class CodeFixAllTests : IDisposable
{
    private const string Inventory = """
        namespace FixAll.Core;

        public static class Inventory
        {
            public static int CountUnits(string[] boxes)
            {
                int units = boxes.Length;
                string label = "units";
                bool stacked = units > 0;
                return stacked ? units : 0;
            }
        }
        """;

    private const string Warehouse = """
        namespace FixAll.Core;

        public static class Warehouse
        {
            public static string NameOf(int zone)
            {
                int capacity = zone * 10;
                string name = $"zone-{zone}";
                return name.Length > capacity ? name : name + capacity;
            }
        }
        """;

    private const string Invoice = """
        using FixAll.Core;

        namespace FixAll.Billing;

        public static class Invoice
        {
            public static decimal TotalOf(int zone, string[] items)
            {
                int id = zone;
                decimal amount = items.Length * 2.5m;
                bool paid = amount == 0m;
                int rounding = id + 1;
                return paid ? 0m : amount + rounding;
            }
        }
        """;

    /// <summary>A block namespace: the preferred style names no severity, so IDE0161
    /// stays at its default hidden severity, yet
    /// its fix — and that fix's fix-all — is listed at the namespace.</summary>
    private const string Legacy = """
        namespace FixAll.Legacy
        {
            public static class Ledger { }
        }
        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-fixall-{Guid.NewGuid():N}");
    private readonly string _slnPath;
    private readonly string _inventoryPath;

    public CodeFixAllTests()
    {
        Directory.CreateDirectory(NativePaths.Join(_root, "Core"));
        Directory.CreateDirectory(NativePaths.Join(_root, "Billing"));
        // Promoting the var styles is what makes IDE0007 report, so the fix —
        // with its fix-all — is offered at every explicit local type.
        const string editorConfig = """
            root = true

            [*.cs]
            csharp_style_var_for_built_in_types = true:warning
            csharp_style_var_when_type_is_apparent = true:warning
            csharp_style_var_elsewhere = true:warning
            csharp_style_namespace_declarations = file_scoped
            """;
        File.WriteAllText(NativePaths.Join(_root, ".editorconfig"), editorConfig);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <Nullable>enable</Nullable>
                <ImplicitUsings>enable</ImplicitUsings>
                <EnableNETAnalyzers>true</EnableNETAnalyzers>
                <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
              </PropertyGroup>
            </Project>
            """;
        const string billingCsproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <Nullable>enable</Nullable>
                <ImplicitUsings>enable</ImplicitUsings>
                <EnableNETAnalyzers>true</EnableNETAnalyzers>
                <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="../Core/Core.csproj" />
              </ItemGroup>
            </Project>
            """;
        File.WriteAllText(NativePaths.Join(_root, "Core", "Core.csproj"), csproj);
        File.WriteAllText(NativePaths.Join(_root, "Billing", "Billing.csproj"), billingCsproj);
        File.WriteAllText(
            NativePaths.Join(_root, "Core", "Settings.cs"),
            "namespace FixAll.Core;\n"
        );
        File.WriteAllText(NativePaths.Join(_root, "Core", "Inventory.cs"), Inventory);
        File.WriteAllText(NativePaths.Join(_root, "Core", "Warehouse.cs"), Warehouse);
        File.WriteAllText(NativePaths.Join(_root, "Billing", "Invoice.cs"), Invoice);
        File.WriteAllText(NativePaths.Join(_root, "Core", "Legacy.cs"), Legacy);
        _slnPath = NativePaths.Join(_root, "FixAll.sln");
        _inventoryPath = NativePaths.Join(_root, "Core", "Inventory.cs");
        WriteSolution();
    }

    private void WriteSolution()
    {
        const string sln = """
            Microsoft Visual Studio Solution File, Format Version 12.00
            Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Core", "Core\Core.csproj", "{10000000-0000-0000-0000-000000000021}"
            EndProject
            Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Billing", "Billing\Billing.csproj", "{10000000-0000-0000-0000-000000000022}"
            EndProject
            Global
            EndGlobal
            """;
        File.WriteAllText(_slnPath, sln);
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
    public async Task A_var_fix_lists_every_scope_and_fixes_each_one()
    {
        using var manager = await OpenAsync();
        var actions = await ListedAsync(manager);
        var offered = actions.FirstOrDefault(action =>
            action.Title.Contains(
                "var' instead of explicit type",
                StringComparison.OrdinalIgnoreCase
            )
        );
        Assert.NotNull(offered);

        // Interaction 1 — the listing reports the key, quickfix kind (since
        // IDE0007 is promoted to warning in .editorconfig, GitHub #586), and every scope.
        // [FIXALL-SCOPES]: occurrences are found by the key, never the title.
        Assert.Equal("quickfix", offered!.Kind);
        Assert.Equal(["document", "project", "solution"], offered!.FixAllScopes);
        Assert.False(string.IsNullOrEmpty(offered.FixKey));
        var fixKey = offered.FixKey!;

        // Interaction 2 — document scope fixes the anchor file only.
        var document = Unwrap(await manager.FixAllAsync(_inventoryPath, fixKey, "document"));
        Assert.Equal([_inventoryPath], FilesOf(document));
        Assert.Equal(3, EditsIn(document, _inventoryPath));

        // Interaction 3 — project scope adds the sibling file of the same project.
        var project = Unwrap(await manager.FixAllAsync(_inventoryPath, fixKey, "project"));
        Assert.Equal(
            [_inventoryPath, NativePaths.Join(_root, "Core", "Warehouse.cs")],
            FilesOf(project)
        );
        Assert.Equal(3, EditsIn(project, _inventoryPath));
        Assert.Equal(2, EditsIn(project, NativePaths.Join(_root, "Core", "Warehouse.cs")));

        // Interaction 4 — solution scope crosses into the second project and
        // never touches the file without a site.
        var solution = Unwrap(await manager.FixAllAsync(_inventoryPath, fixKey, "solution"));
        Assert.Equal(
            [
                NativePaths.Join(_root, "Billing", "Invoice.cs"),
                _inventoryPath,
                NativePaths.Join(_root, "Core", "Warehouse.cs"),
            ],
            FilesOf(solution)
        );
        Assert.Equal(4, EditsIn(solution, NativePaths.Join(_root, "Billing", "Invoice.cs")));
        Assert.DoesNotContain(NativePaths.Join(_root, "Core", "Settings.cs"), FilesOf(solution));

        // The scopes nest: document < project < solution.
        Assert.True(document.DocumentChanges.Count < project.DocumentChanges.Count);
        Assert.True(project.DocumentChanges.Count < solution.DocumentChanges.Count);
    }

    /// <summary>
    /// A fix-all is offered only when it can resolve: the default-hidden
    /// IDE0161 fix is listed at a block namespace, so its fix-all finds that same
    /// occurrence — never "no occurrences" for the site that offered it.
    /// [FIXALL-SCOPES] [REFACTOR-NEVER-SILENT]
    /// </summary>
    [Fact]
    public async Task A_listed_fix_all_for_a_default_hidden_style_rule_resolves()
    {
        using var manager = await OpenAsync();
        var legacyPath = NativePaths.Join(_root, "Core", "Legacy.cs");
        var listed = await manager.GetCodeActionsAsync(legacyPath, 0, 10, 0, 16);
        var actions = listed.Match(value => value, _ => []);
        var offered = actions.FirstOrDefault(action =>
            action.Title.Contains("file-scoped namespace", StringComparison.OrdinalIgnoreCase)
            && action.FixKey is not null
        );
        Assert.True(
            offered is not null,
            string.Join(" | ", actions.Select(action => $"{action.Title}#{action.FixKey}"))
        );
        Assert.Equal("refactor.rewrite", offered!.Kind);
        Assert.Contains("document", offered!.FixAllScopes!);

        var document = Unwrap(await manager.FixAllAsync(legacyPath, offered.FixKey!, "document"));
        Assert.Equal([legacyPath], FilesOf(document));
        Assert.True(EditsIn(document, legacyPath) >= 1);

        // The project holds no other block namespace, so project scope edits the same file.
        var project = Unwrap(await manager.FixAllAsync(legacyPath, offered.FixKey!, "project"));
        Assert.Equal([legacyPath], FilesOf(project));
    }

    /// <summary>
    /// A compiler diagnostic's fix-all resolves too: CS0219 (Inventory's unused
    /// <c>label</c>) comes from the compiler, not an analyzer, and its listed
    /// fix-all must find it. [FIXALL-SCOPES] [REFACTOR-NEVER-SILENT]
    /// </summary>
    [Fact]
    public async Task A_listed_fix_all_for_a_compiler_diagnostic_resolves()
    {
        using var manager = await OpenAsync();
        var listed = await manager.GetCodeActionsAsync(_inventoryPath, 7, 15, 7, 20);
        var actions = listed.Match(value => value, _ => []);
        var offered = actions.FirstOrDefault(action =>
            action.Title.Contains("unused variable", StringComparison.OrdinalIgnoreCase)
            && action.FixKey is not null
        );
        Assert.True(
            offered is not null,
            string.Join(" | ", actions.Select(action => $"{action.Title}#{action.FixKey}"))
        );

        var document = Unwrap(
            await manager.FixAllAsync(_inventoryPath, offered!.FixKey!, "document")
        );
        Assert.Equal([_inventoryPath], FilesOf(document));
        Assert.True(EditsIn(document, _inventoryPath) >= 1);
    }

    [Fact]
    public async Task A_fix_key_never_offered_answers_the_stale_reason()
    {
        using var manager = await OpenAsync();
        var result = await manager.FixAllAsync(_inventoryPath, "NoSuchFix", "document");

        Assert.True(result.IsError);
        Assert.Contains("no longer available", result.Match(_ => "", error => error));
    }

    [Fact]
    public async Task An_unsupported_scope_is_refused_never_narrowed()
    {
        using var manager = await OpenAsync();
        var actions = await ListedAsync(manager);
        var fixKey = actions.First(action => action.FixKey is not null).FixKey!;
        var result = await manager.FixAllAsync(_inventoryPath, fixKey, "galaxy");

        Assert.True(result.IsError);
        Assert.Contains("galaxy", result.Match(_ => "", error => error));
    }

    /// <summary>
    /// GitHub #586 &amp; #585: IDE0007 promoted to error offers a <c>quickfix</c>
    /// (plus all three Fix All scopes) on local declarations, <c>foreach</c>
    /// iteration variables, and <c>out</c> variables, and clears once edited to <c>var</c>.
    /// [FIXALL-SCOPES] [FIXALL-LSP]
    /// </summary>
    [Fact]
    public async Task Promoted_IDE0007_error_offers_quickfix_for_local_foreach_and_out_and_clears_after_edit()
    {
        const string code = """
            namespace FixAll.Core;

            public sealed class Headers
            {
                public int Count(string[] items)
                {
                    int total = 0;
                    foreach (string name in items)
                    {
                        if (int.TryParse(name, out int parsed))
                        {
                            total += parsed;
                        }
                    }
                    return total;
                }
            }
            """;
        await File.WriteAllTextAsync(
            NativePaths.Join(_root, ".editorconfig"),
            """
            root = true

            [*.cs]
            csharp_style_var_for_built_in_types = true:error
            csharp_style_var_when_type_is_apparent = true:error
            csharp_style_var_elsewhere = true:error
            """
        );
        var headersPath = NativePaths.Join(_root, "Core", "Headers.cs");
        await File.WriteAllTextAsync(headersPath, code);
        using var manager = await OpenAsync();

        // Local declaration (`int`), foreach (`string`), and out variable (`int`).
        var sites = new[] { (6, 8, 11), (7, 17, 23), (9, 39, 42) };
        string? fixKey = null;
        foreach (var (line, start, end) in sites)
        {
            var listed = Unwrap(
                await manager.GetCodeActionsAsync(headersPath, line, start, line, end)
            );
            var offered = listed.FirstOrDefault(action =>
                action.Title.Contains("var' instead of explicit type", StringComparison.OrdinalIgnoreCase)
            );
            Assert.NotNull(offered);
            Assert.Equal("quickfix", offered!.Kind);
            Assert.Equal(["document", "project", "solution"], offered.FixAllScopes);
            fixKey ??= offered.FixKey;
        }

        // Apply Fix All (document) and verify IDE0007 clears immediately on the next pull (#585).
        var edit = Unwrap(await manager.FixAllAsync(headersPath, fixKey!, "document"));
        Assert.Equal(3, EditsIn(edit, headersPath));
        var updated = code.Replace("int total = 0;", "var total = 0;")
            .Replace("foreach (string name in items)", "foreach (var name in items)")
            .Replace("out int parsed", "out var parsed");
        Unwrap(await manager.UpdateDocumentTextAsync(headersPath, updated));
        var diagnostics = Unwrap(await manager.GetDiagnosticsAsync(headersPath));
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "IDE0007");
    }

    [Fact]
    public async Task A_file_outside_the_solution_is_refused_never_empty()
    {
        using var manager = await OpenAsync();
        var outside = NativePaths.Join(_root, "Elsewhere.cs");
        await File.WriteAllTextAsync(outside, "class Away { }");
        var result = await manager.FixAllAsync(outside, "UseImplicitType", "document");

        Assert.True(result.IsError);
        Assert.Contains(
            "not part of the loaded C# solution",
            result.Match(_ => "", error => error)
        );
    }

    private async Task<List<CodeActionItem>> ListedAsync(WorkspaceManager manager)
    {
        var result = await manager.GetCodeActionsAsync(_inventoryPath, 6, 8, 6, 11);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var actions = result.Match(value => value, _ => []);
        Assert.NotEmpty(actions);
        return actions;
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var (code, output) = DotnetBuild.Restore(_slnPath);
        Assert.True(code == 0, $"restore failed: {output}");
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercising the real solution-loading boundary
        var opened = await manager.OpenAsync(_slnPath);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        return manager;
    }

    private static List<string> FilesOf(WorkspaceEditResult edit)
    {
        return [.. edit.DocumentChanges.Select(change => change.FilePath).Distinct().Order()];
    }

    private static int EditsIn(WorkspaceEditResult edit, string filePath)
    {
        return edit
            .DocumentChanges.Where(change => NativePaths.AreEqual(change.FilePath, filePath))
            .Sum(change => change.Edits.Count);
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }
}
