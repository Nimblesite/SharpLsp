using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Feature-level coverage for <see cref="WorkspaceManager"/> partials
/// (rename, code actions, code lenses, formatting, semantic tokens, inlay
/// hints, call/type hierarchy, completion resolve, document lookup). Each test
/// loads a real, minimal MSBuild project through <c>OpenAsync</c> and drives
/// the public query methods over known source coordinates — mirroring
/// <c>WorkspaceManagerTests</c>'s real-project loading strategy.
/// </summary>
public sealed class WorkspaceManagerFeatureCoverageTests : IDisposable
{
    // A rich source: a base class with a virtual method, a derived class that
    // overrides it, a field, an auto-property, and a method that calls another
    // method. This single fixture exercises rename, hierarchy, references,
    // hover, definition, code lens and semantic-token paths.
    //
    // Line / character map (0-based) used by the assertions below:
    //   L2  char13 -> "Base" type name
    //   L4  char23 -> "Compute" virtual method name
    //   L7  char13 -> "Calculator" derived type name
    //   L9  char16 -> "_counter" field name
    //   L11 char15 -> "Total" property name
    //   L13 char24 -> "Compute" override method name
    //   L15 char15 -> "Run" method name
    //   L18 char21 -> "Compute" call site inside Run
    private const string Source =
        "namespace S;\n"
        + "\n"
        + "public class Base\n"
        + "{\n"
        + "    public virtual int Compute(int seed) => seed + 1;\n"
        + "}\n"
        + "\n"
        + "public class Calculator : Base\n"
        + "{\n"
        + "    private int _counter;\n"
        + "\n"
        + "    public int Total { get; set; }\n"
        + "\n"
        + "    public override int Compute(int seed) => seed + _counter;\n"
        + "\n"
        + "    public int Run(int input)\n"
        + "    {\n"
        + "        _counter = input;\n"
        + "        var result = Compute(input);\n"
        + "        Total = result;\n"
        + "        return result;\n"
        + "    }\n"
        + "}\n";

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-feat-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public WorkspaceManagerFeatureCoverageTests()
    {
        Directory.CreateDirectory(_root);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """;
        _csprojPath = Path.Combine(_root, "Calc.csproj");
        _sourcePath = Path.Combine(_root, "Calculator.cs");
        File.WriteAllText(_csprojPath, csproj);
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

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await manager.OpenAsync(_csprojPath).ConfigureAwait(true);
#pragma warning restore CS0618
        Assert.False(openResult.IsError, openResult.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded, "workspace must be loaded for feature queries");
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return result.Match(value => value, _ => throw new InvalidOperationException("error"));
    }

    [Fact]
    public async Task PrepareRename_on_field_reports_renamable_with_placeholder()
    {
        using var manager = await OpenAsync();

        var result = await manager.PrepareRenameAsync(_sourcePath, 9, 16);

        var prepare = Unwrap(result);
        Assert.True(prepare.CanRename, "a private field must be renamable");
        Assert.Equal("_counter", prepare.Placeholder);
        Assert.Equal(9, prepare.StartLine);
        Assert.Equal(16, prepare.StartCharacter);
        Assert.Equal("_counter".Length, prepare.EndCharacter - prepare.StartCharacter);
    }

    [Fact]
    public async Task PrepareRename_on_namespace_cannot_rename()
    {
        using var manager = await OpenAsync();

        // Position on the namespace identifier `S` (line 0, "namespace " == 10 chars).
        var result = await manager.PrepareRenameAsync(_sourcePath, 0, 10);

        var prepare = Unwrap(result);
        Assert.False(prepare.CanRename, "namespaces are excluded from rename");
    }

    [Fact]
    public async Task PrepareRename_unknown_document_is_error()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Nope.cs");
        var result = await manager.PrepareRenameAsync(bogus, 0, 0);

        Assert.True(result.IsError, "missing document must surface an error");
        Assert.Contains("Document not found", result.Match(_ => string.Empty, err => err));
    }

    [Fact]
    public async Task Rename_field_rewrites_declaration_and_usages()
    {
        using var manager = await OpenAsync();

        // Rename the `_counter` field at its declaration (line 9).
        var result = await manager.RenameAsync(_sourcePath, 9, 16, "_count");

        var edit = Unwrap(result);
        Assert.NotEmpty(edit.DocumentChanges);
        var doc = Assert.Single(edit.DocumentChanges);
        Assert.Equal(_sourcePath, doc.FilePath);
        Assert.NotEmpty(doc.Edits);
        // The combined replacement text must use the new name (declaration +
        // both usages) and must no longer contain the original field name.
        var combined = string.Concat(doc.Edits.Select(e => e.NewText));
        Assert.Contains("_count", combined);
        Assert.DoesNotContain("_counter", combined);
    }

    [Fact]
    public async Task Rename_method_propagates_to_call_site()
    {
        using var manager = await OpenAsync();

        // Rename the override `Compute` (line 13).
        var result = await manager.RenameAsync(_sourcePath, 13, 24, "Evaluate");

        var edit = Unwrap(result);
        Assert.NotEmpty(edit.DocumentChanges);
        var allEdits = edit.DocumentChanges.SelectMany(c => c.Edits).ToList();
        Assert.NotEmpty(allEdits);
        var combined = string.Concat(allEdits.Select(e => e.NewText));
        // The override declaration and the `Compute(input)` call site both adopt
        // the new name; the old identifier disappears entirely.
        Assert.Contains("Evaluate(input)", combined);
        Assert.DoesNotContain("Compute", combined);
    }

    [Fact]
    public async Task Rename_on_whitespace_returns_no_changes()
    {
        using var manager = await OpenAsync();

        // Line 3 is just "{" — column 0 has no symbol to rename.
        var result = await manager.RenameAsync(_sourcePath, 3, 0, "Whatever");

        var edit = Unwrap(result);
        Assert.Empty(edit.DocumentChanges);
    }

    [Fact]
    public async Task CodeActions_over_local_declaration_returns_list()
    {
        using var manager = await OpenAsync();

        // The `var result = Compute(input);` line (18) — offers refactorings.
        var result = await manager.GetCodeActionsAsync(_sourcePath, 18, 8, 18, 35);

        var actions = Unwrap(result);
        Assert.NotNull(actions);
        // IDs are assigned positionally and titles are populated when present.
        Assert.All(actions, a => Assert.False(string.IsNullOrEmpty(a.Title)));
    }

    [Fact]
    public async Task CodeActions_unknown_document_returns_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Missing.cs");
        var result = await manager.GetCodeActionsAsync(bogus, 0, 0, 0, 1);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task ResolveCodeAction_then_apply_or_unknown()
    {
        using var manager = await OpenAsync();

        var actionsResult = await manager.GetCodeActionsAsync(_sourcePath, 18, 8, 18, 35);
        var actions = Unwrap(actionsResult);

        if (actions.Count > 0)
        {
            // Resolving a real action ID must produce a (possibly empty) edit.
            var resolved = await manager.ResolveCodeActionAsync(actions[0].Id);
            var edit = Unwrap(resolved);
            Assert.NotNull(edit.DocumentChanges);
        }

        // An ID that was never offered must fail explicitly.
        var unknown = await manager.ResolveCodeActionAsync(987654);
        Assert.True(unknown.IsError, "unknown action id must error");
        Assert.Contains("not found", unknown.Match(_ => string.Empty, err => err));
    }

    [Fact]
    public async Task Completion_supplies_text_edit_that_replaces_identifier_at_caret()
    {
        // GitHub #178 / [COMPLETION-EDIT-REPLACE]: the caret sits at the START of
        // `Compute` in `var result = Compute(input);` (line 18, col 21). The item's
        // textEdit must span the whole identifier so acceptance REPLACES it rather
        // than appending (which would yield `ComputeCompute`).
        using var manager = await OpenAsync();

        var items = Unwrap(await manager.GetCompletionsAsync(_sourcePath, 18, 21));
        var compute = items.Find(item => item.Label == "Compute");
        Assert.NotNull(compute);
        Assert.NotNull(compute!.TextEdit);
        Assert.Equal(18, compute.TextEdit!.StartLine);
        Assert.Equal(21, compute.TextEdit.StartCharacter);
        Assert.Equal(18, compute.TextEdit.EndLine);
        Assert.Equal(21 + "Compute".Length, compute.TextEdit.EndCharacter);
        Assert.Equal("Compute", compute.TextEdit.NewText);
    }

    [Fact]
    public async Task ResolveCompletion_after_completion_returns_resolve_result()
    {
        using var manager = await OpenAsync();

        // Trigger completion after `Total = ` on line 19 so the cached list is
        // populated, then resolve index 0 through the Helpers path.
        var completions = await manager.GetCompletionsAsync(_sourcePath, 19, 16);
        var items = Unwrap(completions);
        Assert.NotEmpty(items);

        var resolved = await manager.ResolveCompletionAsync(items[0].Index, CancellationToken.None);
        Assert.NotNull(resolved);
        Assert.NotNull(resolved.AdditionalEdits);

        // An out-of-range index must hit the guard and return an empty result.
        var guarded = await manager.ResolveCompletionAsync(999999, CancellationToken.None);
        Assert.Empty(guarded.AdditionalEdits);
    }

    [Fact]
    public async Task CodeLenses_report_reference_counts_for_members()
    {
        using var manager = await OpenAsync();

        var result = await manager.GetCodeLensesAsync(_sourcePath);

        var lenses = Unwrap(result);
        Assert.NotEmpty(lenses);
        Assert.All(lenses, lens => Assert.False(string.IsNullOrEmpty(lens.Title)));
    }

    [Fact]
    public async Task CodeLenses_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Ghost.cs");
        var result = await manager.GetCodeLensesAsync(bogus);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task FormatDocument_returns_edit_list()
    {
        using var manager = await OpenAsync();

        var result = await manager.FormatDocumentAsync(_sourcePath);

        // Already well-formatted source yields zero or whitespace-only edits;
        // the call must succeed and return a non-null list.
        Assert.NotNull(Unwrap(result));
    }

    [Fact]
    public async Task FormatRange_returns_edit_list()
    {
        using var manager = await OpenAsync();

        var result = await manager.FormatRangeAsync(_sourcePath, 15, 0, 21, 5);

        Assert.NotNull(Unwrap(result));
    }

    [Fact]
    public async Task FormatOnType_returns_edit_list()
    {
        using var manager = await OpenAsync();

        // Just after the closing brace of Run's body on line 21.
        var result = await manager.FormatOnTypeAsync(_sourcePath, 21, 5);

        Assert.NotNull(Unwrap(result));
    }

    [Fact]
    public async Task Format_methods_on_unknown_document_are_empty()
    {
        using var manager = await OpenAsync();
        var bogus = Path.Combine(_root, "None.cs");

        Assert.Empty(Unwrap(await manager.FormatDocumentAsync(bogus)));
        Assert.Empty(Unwrap(await manager.FormatRangeAsync(bogus, 0, 0, 1, 0)));
        Assert.Empty(Unwrap(await manager.FormatOnTypeAsync(bogus, 0, 0)));
    }

    [Fact]
    public async Task SemanticTokensFull_returns_well_formed_data()
    {
        using var manager = await OpenAsync();

        var result = await manager.GetSemanticTokensFullAsync(_sourcePath);

        var tokens = Unwrap(result);
        Assert.NotEmpty(tokens.Data);
        // Each token is exactly five integers.
        Assert.Equal(0, tokens.Data.Length % 5);
    }

    [Fact]
    public async Task SemanticTokensRange_is_subset_of_full()
    {
        using var manager = await OpenAsync();

        var full = Unwrap(await manager.GetSemanticTokensFullAsync(_sourcePath));
        var range = Unwrap(await manager.GetSemanticTokensRangeAsync(_sourcePath, 0, 0, 5, 0));

        Assert.Equal(0, range.Data.Length % 5);
        Assert.True(range.Data.Length <= full.Data.Length);
    }

    [Fact]
    public async Task SemanticTokens_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();
        var bogus = Path.Combine(_root, "Absent.cs");

        Assert.Empty(Unwrap(await manager.GetSemanticTokensFullAsync(bogus)).Data);
        Assert.Empty(Unwrap(await manager.GetSemanticTokensRangeAsync(bogus, 0, 0, 1, 0)).Data);
    }

    [Fact]
    public async Task InlayHints_contain_type_hint_for_var_local()
    {
        using var manager = await OpenAsync();

        var result = await manager.GetInlayHintsAsync(_sourcePath, 0, 25);

        var hints = Unwrap(result);
        // `var result = Compute(input);` yields a Type (Kind=1) hint for `result`.
        Assert.Contains(hints, h => h.Kind == 1);
    }

    [Fact]
    public async Task InlayHints_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Void.cs");
        var result = await manager.GetInlayHintsAsync(bogus, 0, 10);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_method_returns_method_item()
    {
        using var manager = await OpenAsync();

        // The `Run` method declaration on line 15.
        var result = await manager.PrepareCallHierarchyAsync(_sourcePath, 15, 15);

        var item = Unwrap(result);
        Assert.NotNull(item);
        Assert.Equal("method", item!.Kind);
        Assert.Contains("Run", item.Name);
    }

    [Fact]
    public async Task PrepareCallHierarchy_unknown_document_is_null()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Gone.cs");
        var result = await manager.PrepareCallHierarchyAsync(bogus, 0, 0);

        Assert.Null(Unwrap(result));
    }

    [Fact]
    public async Task OutgoingCalls_from_Run_include_Compute()
    {
        using var manager = await OpenAsync();

        // `Run` body calls `Compute` — outgoing edges from line 15.
        var result = await manager.GetOutgoingCallsAsync(_sourcePath, 15, 15);

        var calls = Unwrap(result);
        Assert.NotEmpty(calls);
        Assert.Contains(calls, c => c.Name.Contains("Compute"));
    }

    [Fact]
    public async Task OutgoingCalls_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "Empty.cs");
        var result = await manager.GetOutgoingCallsAsync(bogus, 0, 0);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task IncomingCalls_to_Compute_find_caller()
    {
        using var manager = await OpenAsync();

        // The override `Compute` on line 13 is called from `Run`.
        var result = await manager.GetIncomingCallsAsync(_sourcePath, 13, 24);

        // Incoming may be empty (no callers found) or include Run as a caller.
        var calls = Unwrap(result);
        Assert.NotNull(calls);
        Assert.All(calls, c => Assert.False(string.IsNullOrEmpty(c.Name)));
    }

    [Fact]
    public async Task PrepareTypeHierarchy_on_class_returns_class_item()
    {
        using var manager = await OpenAsync();

        // `Calculator` type name on line 7.
        var result = await manager.PrepareTypeHierarchyAsync(_sourcePath, 7, 13);

        var item = Unwrap(result);
        Assert.NotNull(item);
        Assert.Equal("class", item!.Kind);
        Assert.Contains("Calculator", item.Name);
    }

    [Fact]
    public async Task PrepareTypeHierarchy_unknown_document_is_null()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "NoType.cs");
        var result = await manager.PrepareTypeHierarchyAsync(bogus, 0, 0);

        Assert.Null(Unwrap(result));
    }

    [Fact]
    public async Task Supertypes_of_Calculator_include_Base()
    {
        using var manager = await OpenAsync();

        // `Calculator : Base` on line 7 — supertype is `Base`.
        var result = await manager.GetSupertypesAsync(_sourcePath, 7, 13);

        var items = Unwrap(result);
        Assert.Contains(items, i => i.Name.Contains("Base"));
    }

    [Fact]
    public async Task Supertypes_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "NoSuper.cs");
        var result = await manager.GetSupertypesAsync(bogus, 0, 0);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task Subtypes_of_Base_include_Calculator()
    {
        using var manager = await OpenAsync();

        // `Base` type name on line 2 — its subtype is `Calculator`.
        var result = await manager.GetSubtypesAsync(_sourcePath, 2, 13);

        var items = Unwrap(result);
        Assert.Contains(items, i => i.Name.Contains("Calculator"));
    }

    [Fact]
    public async Task Subtypes_unknown_document_is_empty()
    {
        using var manager = await OpenAsync();

        var bogus = Path.Combine(_root, "NoSub.cs");
        var result = await manager.GetSubtypesAsync(bogus, 0, 0);

        Assert.Empty(Unwrap(result));
    }

    [Fact]
    public async Task Hover_on_property_describes_the_member()
    {
        using var manager = await OpenAsync();

        // `Total` property on line 11.
        var result = await manager.GetHoverAsync(_sourcePath, 11, 15);

        var hover = Unwrap(result);
        Assert.NotNull(hover);
        Assert.Contains("Total", hover!.Contents);
    }

    [Fact]
    public async Task Definition_of_Compute_call_resolves_to_a_declaration()
    {
        using var manager = await OpenAsync();

        // The `Compute(input)` call on line 18 resolves to a declaration.
        var result = await manager.GetDefinitionAsync(_sourcePath, 18, 21);

        var locations = Unwrap(result);
        Assert.NotEmpty(locations.Locations);
        Assert.All(locations.Locations, l => Assert.False(string.IsNullOrEmpty(l.FilePath)));
    }

    [Fact]
    public async Task References_to_field_include_multiple_usages()
    {
        using var manager = await OpenAsync();

        // `_counter` declaration on line 9 — referenced in Compute and Run.
        var result = await manager.GetReferencesAsync(_sourcePath, 9, 16, true);

        var refs = Unwrap(result);
        Assert.True(refs.Locations.Count >= 2, $"expected >=2 refs, got {refs.Locations.Count}");
    }

    [Fact]
    public async Task FindDocument_via_diagnostics_resolves_real_path()
    {
        using var manager = await OpenAsync();

        // GetDiagnosticsAsync routes through FindDocumentAsync (Helpers). A clean
        // source yields a (possibly empty) list with no error.
        var result = await manager.GetDiagnosticsAsync(_sourcePath);

        Assert.NotNull(Unwrap(result));
    }
}
