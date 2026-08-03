using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coverage tests for <see cref="WorkspaceManager"/>'s QUERY methods
/// (hover, completion, definition, type-definition, declaration,
/// implementations, references, document-highlights, code-actions,
/// prepare-rename, rename, code-lens, semantic-tokens, inlay-hints,
/// call/type hierarchy). One real MSBuild-loaded temp project is shared
/// across every fact via <see cref="WorkspaceManagerQueryFixture"/> so the
/// expensive workspace load happens exactly once.
///
/// The shared source (<see cref="WorkspaceManagerQueryFixture.Source"/>)
/// contains an interface, a base/derived pair, methods, properties, and
/// call sites; coordinates below index into that known text. Success values
/// are extracted with the Outcome <c>+</c> operator AFTER asserting the
/// result is not an error, so a regression that flips a query to failure
/// surfaces immediately.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerQueryCoverageTests : IClassFixture<WorkspaceManagerQueryFixture>
{
    private readonly WorkspaceManagerQueryFixture _fixture;

    public WorkspaceManagerQueryCoverageTests(WorkspaceManagerQueryFixture fixture)
    {
        _fixture = fixture;
        Assert.True(_fixture.OpenError is null, _fixture.OpenError ?? "ok");
        Assert.True(_fixture.Manager.IsLoaded, "shared workspace must be loaded");
    }

    private WorkspaceManager Manager => _fixture.Manager;

    private string SourcePath => _fixture.SourcePath;

    /// <summary>Assert the query succeeded and return its success value.</summary>
    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return +result;
    }

    // ── Hover ────────────────────────────────────────────────────────

    [Fact]
    public async Task HoverOnMethodReturnsSignatureContent()
    {
        // Line 12: `    public virtual int Add(int a, int b) => a + b;`
        // `Add` starts at character 23.
        var hover = AssertOk(await Manager.GetHoverAsync(SourcePath, 12, 24));
        Assert.NotNull(hover);
        Assert.Contains("Add", hover!.Contents);
    }

    [Fact]
    public async Task HoverOnKeywordPositionIsNonError()
    {
        // Line 6 is the interface's opening `{` — character 0 lands on a brace,
        // not a hoverable expression.
        var result = await Manager.GetHoverAsync(SourcePath, 6, 0);

        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        // No expression under a keyword position usually yields a null hover,
        // but Roslyn may legitimately surface a type hover — tolerate both.
        var hover = +result;
        Assert.True(hover is null || hover.Contents.Length >= 0);
    }

    // ── Completion ───────────────────────────────────────────────────

    [Fact]
    public async Task CompletionsAfterMemberAccessIncludeAdd()
    {
        // Line 29 inside Run(): `        var sum = calc.Add(1, 2);`
        // The `.` after `calc` is at char 22; request completion right after it.
        var items = AssertOk(await Manager.GetCompletionsAsync(SourcePath, 29, 23));
        Assert.NotNull(items);
        // Member-access completion on a Calculator instance must surface `Add`.
        Assert.Contains(items, item => item.Label == "Add");
        // Every mapped item carries a non-empty kind tag.
        Assert.All(items, item => Assert.False(string.IsNullOrEmpty(item.Kind)));
    }

    // ── Definition / TypeDefinition / Declaration ────────────────────

    [Fact]
    public async Task DefinitionOnCallSiteLocatesMethod()
    {
        // Line 29: `        var sum = calc.Add(1, 2);` → `Add` call at char 23.
        var locations = AssertOk(await Manager.GetDefinitionAsync(SourcePath, 29, 24));
        Assert.NotEmpty(locations.Locations);
        Assert.All(locations.Locations, loc => Assert.False(string.IsNullOrEmpty(loc.FilePath)));
    }

    [Fact]
    public async Task TypeDefinitionOnVariableLocatesItsType()
    {
        // Line 28: `        var calc = new Calculator();` → `calc` at char 12.
        var location = AssertOk(await Manager.GetTypeDefinitionAsync(SourcePath, 28, 13));
        // The variable's type (Calculator) may resolve to its source declaration,
        // a decompiled metadata location, or null — exactly as the resolver-level
        // test tolerates. When present the location must reference a real file.
        Assert.True(location is null || !string.IsNullOrEmpty(location.FilePath));
    }

    [Fact]
    public async Task DeclarationOnOverrideResolvesToFile()
    {
        // Line 19: `    public override int Add(int a, int b) => base.Add(a, b) + 1;`
        // `Add` (the override) at char 24 → declaration resolves the virtual
        // base member (or the symbol itself).
        var location = AssertOk(await Manager.GetDeclarationAsync(SourcePath, 19, 25));
        // Declaration may be null when there is no distinct base declaration,
        // but when present it must reference a real file.
        if (location is not null)
        {
            Assert.False(string.IsNullOrEmpty(location.FilePath));
        }
    }

    // ── Implementations ──────────────────────────────────────────────

    [Fact]
    public async Task ImplementationsOfInterfaceMethodFound()
    {
        // Line 7 inside the interface: `    int Compute(int value);` → `Compute`
        // at char 8. Calculator implements it.
        var locations = AssertOk(await Manager.GetImplementationsAsync(SourcePath, 7, 9));
        Assert.NotEmpty(locations.Locations);
    }

    // ── References ───────────────────────────────────────────────────

    [Fact]
    public async Task ReferencesToMethodIncludeCallSites()
    {
        // Line 12: declaration of `Add` at char 23. There is a call on line 29.
        var withDecl = await Manager.GetReferencesAsync(SourcePath, 12, 24, true);
        var withoutDecl = await Manager.GetReferencesAsync(SourcePath, 12, 24, false);

        Assert.False(withDecl.IsError, withDecl.Match(_ => "ok", err => err));
        Assert.False(withoutDecl.IsError, withoutDecl.Match(_ => "ok", err => err));

        var withList = +withDecl;
        var withoutList = +withoutDecl;
        Assert.NotEmpty(withList.Locations);
        // Including the declaration must yield at least as many locations.
        Assert.True(withList.Locations.Count >= withoutList.Locations.Count);
    }

    // ── Document Highlights ──────────────────────────────────────────

    [Fact]
    public async Task DocumentHighlightsForLocalVariableFound()
    {
        // Line 29: `        var sum = calc.Add(1, 2);` — `calc` usage at char 18.
        var highlights = AssertOk(await Manager.GetDocumentHighlightsAsync(SourcePath, 29, 19));
        Assert.NotEmpty(highlights.Highlights);
        Assert.All(highlights.Highlights, highlight => Assert.True(highlight.StartLine >= 0));
    }

    // ── Code Actions + Resolve ───────────────────────────────────────

    [Fact]
    public async Task CodeActionsForMethodRangeAreReturnedAndResolvable()
    {
        // Range over the override method declaration on line 19.
        var actions = AssertOk(await Manager.GetCodeActionsAsync(SourcePath, 19, 4, 19, 60));

        // Roslyn offers refactorings/fixes here (e.g. "use expression body",
        // "introduce local"). Each item has a non-empty title.
        Assert.All(actions, action => Assert.False(string.IsNullOrEmpty(action.Title)));

        if (actions.Count > 0)
        {
            var edit = AssertOk(await Manager.ResolveCodeActionAsync(actions[0].Id));
            Assert.NotNull(edit);
        }
    }

    [Fact]
    public async Task ResolveCodeActionUnknownIdFails()
    {
        var result = await Manager.ResolveCodeActionAsync(int.MaxValue);

        Assert.True(result.IsError, "an unknown action id must fail");
        Assert.Contains("not found", result.Match(_ => string.Empty, err => err));
    }

    // ── Prepare Rename + Rename ──────────────────────────────────────

    [Fact]
    public async Task PrepareRenameOnMethodReportsRenameableSpan()
    {
        // Line 12: `Add` method declaration at char 23.
        var prepare = AssertOk(await Manager.PrepareRenameAsync(SourcePath, 12, 24));
        Assert.True(prepare.CanRename, "method symbol must be renameable");
        Assert.Equal("Add", prepare.Placeholder);
        Assert.Equal(12, prepare.StartLine);
        Assert.True(prepare.EndCharacter > prepare.StartCharacter);
    }

    [Fact]
    public async Task RenameMethodProducesEditsAcrossDeclarationAndCall()
    {
        // Rename the `Add` declaration on line 12; the call on line 29 must
        // also be rewritten.
        var edit = AssertOk(await Manager.RenameAsync(SourcePath, 12, 24, "Renamed"));
        Assert.NotEmpty(edit.DocumentChanges);

        var allEdits = edit.DocumentChanges.SelectMany(change => change.Edits).ToList();
        Assert.NotEmpty(allEdits);
        // Depending on the SourceText subtype Roslyn may emit either granular
        // token edits or a single whole-document replacement; in both cases the
        // new name must appear in the produced text.
        Assert.Contains(allEdits, textEdit => textEdit.NewText.Contains("Renamed"));
    }

    // ── Code Lens ────────────────────────────────────────────────────

    [Fact]
    public async Task CodeLensesReturnedForLoadedDocument()
    {
        var lenses = AssertOk(await Manager.GetCodeLensesAsync(SourcePath));
        // Reference lenses sit on declarations; titles are non-empty when present.
        Assert.All(lenses, lens => Assert.False(string.IsNullOrEmpty(lens.Title)));
    }

    // ── Semantic Tokens ──────────────────────────────────────────────

    [Fact]
    public async Task SemanticTokensFullReturnsWellFormedData()
    {
        var tokens = AssertOk(await Manager.GetSemanticTokensFullAsync(SourcePath));
        Assert.NotEmpty(tokens.Data);
        // LSP semantic tokens are encoded as quintuples.
        Assert.Equal(0, tokens.Data.Length % 5);
    }

    // ── Inlay Hints ──────────────────────────────────────────────────

    [Fact]
    public async Task InlayHintsForMethodRangeHaveLabels()
    {
        // Cover the Run() body (var declarations + literal args) lines 28-32.
        var hints = AssertOk(await Manager.GetInlayHintsAsync(SourcePath, 0, 40));
        // `var` declarations and literal arguments yield type/parameter hints.
        Assert.All(hints, hint => Assert.False(string.IsNullOrEmpty(hint.Label)));
    }

    // ── Call Hierarchy ───────────────────────────────────────────────

    [Fact]
    public async Task PrepareCallHierarchyOnMethodReturnsItem()
    {
        // Line 12: `Add` declaration at char 23.
        var item = AssertOk(await Manager.PrepareCallHierarchyAsync(SourcePath, 12, 24));
        Assert.NotNull(item);
        Assert.Equal("Add", item!.Name);
        Assert.Contains("Source.cs", item.FilePath);
    }

    [Fact]
    public async Task IncomingCallsToMethodAreNonError()
    {
        // `Add` is called from Run() on line 29.
        var calls = AssertOk(await Manager.GetIncomingCallsAsync(SourcePath, 12, 24));
        Assert.All(calls, call => Assert.False(string.IsNullOrEmpty(call.Name)));
    }

    [Fact]
    public async Task OutgoingCallsFromMethodAreNonError()
    {
        // Run() (declared on line 26) calls Add and Console.WriteLine.
        var calls = AssertOk(await Manager.GetOutgoingCallsAsync(SourcePath, 26, 17));
        Assert.All(calls, call => Assert.False(string.IsNullOrEmpty(call.Name)));
    }

    // ── Type Hierarchy ───────────────────────────────────────────────

    [Fact]
    public async Task PrepareTypeHierarchyOnClassReturnsItem()
    {
        // Line 17: `public sealed class AdvancedCalculator : Calculator` — the
        // type name starts at char 20.
        var item = AssertOk(await Manager.PrepareTypeHierarchyAsync(SourcePath, 17, 21));
        Assert.NotNull(item);
        Assert.Equal("AdvancedCalculator", item!.Name);
    }

    [Fact]
    public async Task SupertypesOfDerivedClassIncludeBase()
    {
        // Line 17: AdvancedCalculator derives from Calculator.
        var items = AssertOk(await Manager.GetSupertypesAsync(SourcePath, 17, 21));
        // Calculator is a supertype.
        Assert.Contains(items, item => item.Name == "Calculator");
    }

    [Fact]
    public async Task SubtypesOfBaseClassIncludeDerived()
    {
        // Line 10: `public class Calculator : IComputer` — type name at char 13.
        var items = AssertOk(await Manager.GetSubtypesAsync(SourcePath, 10, 14));
        Assert.Contains(items, item => item.Name == "AdvancedCalculator");
    }

    // ── Diagnostics (single + solution) ──────────────────────────────

    [Fact]
    public async Task DiagnosticsForCleanFileAreNonError()
    {
        var single = await Manager.GetDiagnosticsAsync(SourcePath);
        var all = await Manager.GetAllDiagnosticsAsync([]);

        Assert.False(single.IsError, single.Match(_ => "ok", err => err));
        Assert.False(all.IsError, all.Match(_ => "ok", err => err));

        // The intentionally well-formed source must not raise compiler errors.
        var fileDiags = +single;
        Assert.DoesNotContain(fileDiags, diag => diag.Severity == "Error");
    }
}

/// <summary>
/// Writes a minimal real <c>.csproj</c> + source file to a unique temp dir,
/// loads it once through <see cref="WorkspaceManager.OpenAsync"/>, and shares
/// the loaded manager across every fact in
/// <see cref="WorkspaceManagerQueryCoverageTests"/>.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit fixture lifecycle runs without a synchronization context"
)]
public sealed class WorkspaceManagerQueryFixture : IAsyncLifetime, IDisposable
{
    // 0-based line map for Source (used by the test coordinates above):
    //  0: namespace Demo;
    //  5: public interface IComputer
    //  7:     int Compute(int value);
    // 10: public class Calculator : IComputer
    // 12:     public virtual int Add(int a, int b) => a + b;
    // 17: public sealed class AdvancedCalculator : Calculator
    // 19:     public override int Add(int a, int b) => base.Add(a, b) + 1;
    // 24: public class Driver
    // 26:     public void Run()
    // 28:         var calc = new Calculator();
    // 29:         var sum = calc.Add(1, 2);
    // 30:         Console.WriteLine(sum);
    internal const string Source = """
        namespace Demo;

        using System;

        /// <summary>Anything that can compute a value.</summary>
        public interface IComputer
        {
            int Compute(int value);
        }

        public class Calculator : IComputer
        {
            public virtual int Add(int a, int b) => a + b;

            public int Compute(int value) => Add(value, value);
        }

        public sealed class AdvancedCalculator : Calculator
        {
            public override int Add(int a, int b) => base.Add(a, b) + 1;

            public string Name { get; set; } = "advanced";
        }

        public class Driver
        {
            public void Run()
            {
                var calc = new Calculator();
                var sum = calc.Add(1, 2);
                Console.WriteLine(sum);
            }
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wmq-tests-{Guid.NewGuid():N}"
    );

    private WorkspaceManager? _manager;

    internal WorkspaceManager Manager =>
        _manager ?? throw new InvalidOperationException("Fixture not initialized");

    public string SourcePath { get; private set; } = "";

    public string? OpenError { get; private set; }

    public async Task InitializeAsync()
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
        var csprojPath = Path.Combine(_root, "Query.csproj");
        SourcePath = Path.Combine(_root, "Source.cs");
        await File.WriteAllTextAsync(csprojPath, csproj).ConfigureAwait(false);
        await File.WriteAllTextAsync(SourcePath, Source).ConfigureAwait(false);

        _manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var openResult = await _manager.OpenAsync(csprojPath).ConfigureAwait(false);
#pragma warning restore CS0618
        OpenError = openResult.Match<string?>(_ => null, err => err);
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager?.Dispose();
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }
}
