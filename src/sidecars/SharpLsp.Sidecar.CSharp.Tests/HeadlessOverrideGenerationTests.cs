using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for the headless "Generate overrides..." action
/// ([REFACTOR-OVERRIDE-HEADLESS]).
///
/// Roslyn's own implement/override feature components are MEF-only and
/// unavailable in a headless host, so the sidecar builds the declarations
/// itself. The action was previously only ever *offered* in tests, never
/// applied, so every declaration-building path ran zero times: the generator
/// could have emitted uncompilable C# without a single test noticing. These
/// tests apply the action against a real MSBuild project and assert on the C#
/// that comes back.
/// </summary>
public sealed class HeadlessOverrideGenerationTests : IDisposable
{
    // A base class covering every shape the generator special-cases: plain and
    // generic methods (with and without constraints, and with nullable
    // annotations that force an explicit constraint clause on the override), a
    // read/write property, a get-only property, an init-only property, an
    // indexer, an event, and a non-public member whose accessibility must be
    // carried across.
    private const string Source = """
        using System;

        namespace Overrides;

        public abstract class Shape
        {
            public abstract int Compute(int seed);

            public abstract T? Pick<T>(T? value);

            public abstract TRef? PickReference<TRef>(TRef? value)
                where TRef : class;

            public abstract T[]? PickArray<T>(T?[] values);

            public abstract int Total { get; set; }

            public abstract string Name { get; }

            public abstract int Seed { get; init; }

            public abstract int this[int index] { get; set; }

            public abstract event EventHandler? Changed;

            protected abstract void Reset();
        }

        public class Square : Shape
        {
        }

        public class Circle : Shape
        {
            public override int Compute(int seed) => seed;

            public override int Total { get; set; }

            public override T? Pick<T>(T? value)
                where T : default => value;

            public override TRef? PickReference<TRef>(TRef? value)
                where TRef : class => value;

            public override T[]? PickArray<T>(T?[] values)
                where T : default => null;
        }
        """;

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-override-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public HeadlessOverrideGenerationTests()
    {
        Directory.CreateDirectory(_root);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """;
        _csprojPath = Path.Combine(_root, "Shapes.csproj");
        _sourcePath = Path.Combine(_root, "Shapes.cs");
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

    [Fact]
    public async Task Override_action_is_offered_on_a_type_that_leaves_members_unimplemented()
    {
        using var manager = await OpenAsync();
        var actions = Unwrap(await CodeActionsOnTypeAsync(manager, "public class Square : Shape"));
        Assert.Contains(actions, action => action.Title == "Generate overrides...");
    }

    [Fact]
    public async Task Members_the_type_already_overrides_are_not_generated_again()
    {
        using var manager = await OpenAsync();
        // `Circle` already overrides `Compute` and `Total`. Regenerating either
        // would produce a duplicate member and break the build, so the
        // candidate scan must treat an occupied slot as satisfied.
        var generated = await ApplyOverrideActionAsync(manager, "public class Circle : Shape");

        // Count inside `Circle` only: the abstract declarations up in `Shape`
        // carry the same names and would mask a duplicate.
        var circle = generated[
            generated.IndexOf("public class Circle", StringComparison.Ordinal)..
        ];

        Assert.Equal(1, CountOccurrences(circle, "Compute(int seed)"));
        Assert.Equal(1, CountOccurrences(circle, "int Total"));

        // Generic signatures must match too: type-parameter ordinal, array rank
        // and element type, and constructed generic arguments all feed the
        // "is this slot already filled" decision. A false negative here emits a
        // duplicate member and breaks the build.
        Assert.Equal(1, CountOccurrences(circle, "Pick<T>"));
        Assert.Equal(1, CountOccurrences(circle, "PickReference<TRef>"));
        Assert.Equal(1, CountOccurrences(circle, "PickArray<T>"));

        // The members it has not overridden are still generated.
        Assert.Contains("override string Name", circle);
        Assert.Contains("override int this[int index]", circle);
        Assert.Contains("protected override void Reset()", circle);

        AssertParses(generated);
    }

    /// <summary>The generated file must still be syntactically valid C#.</summary>
    private static void AssertParses(string generated)
    {
        var errors = CSharpSyntaxTree
            .ParseText(generated)
            .GetDiagnostics()
            .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
            .Select(diagnostic => diagnostic.ToString())
            .ToList();
        Assert.Empty(errors);
    }

    private static int CountOccurrences(string source, string value)
    {
        return source.Split(value, StringSplitOptions.None).Length - 1;
    }

    [Fact]
    public async Task Applying_the_action_generates_compilable_overrides_for_every_member_shape()
    {
        using var manager = await OpenAsync();
        var generated = await ApplyOverrideActionAsync(manager);

        // Every abstract member of the base must now have an override.
        Assert.Contains("public override int Compute(int seed)", generated);
        Assert.Contains("public override int Total", generated);
        Assert.Contains("public override string Name", generated);
        Assert.Contains("public override int this[int index]", generated);
        Assert.Contains("public override event EventHandler", generated);
        // Accessibility is carried across rather than widened to public.
        Assert.Contains("protected override void Reset()", generated);
        Assert.DoesNotContain("public override void Reset()", generated);

        // Bodies throw rather than returning a default, so an unimplemented
        // override fails loudly at runtime instead of silently returning 0.
        Assert.Contains("throw new NotImplementedException()", generated);

        // The whole file must still parse. A generator that emits malformed
        // members is the exact failure this suite exists to catch.
        AssertParses(generated);
    }

    [Fact]
    public async Task Generic_overrides_carry_the_constraint_clause_their_nullability_requires()
    {
        using var manager = await OpenAsync();
        var generated = await ApplyOverrideActionAsync(manager);

        // `T?` on an unconstrained parameter is only legal on the override when
        // the constraint is restated; C# spells that `where T : default`.
        Assert.Contains("Pick<T>", generated);
        Assert.Contains("where T : default", generated);

        // A `class`-constrained parameter restates `where TRef : class` instead.
        Assert.Contains("PickReference<TRef>", generated);
        Assert.Contains("where TRef : class", generated);

        // Nullability nested inside an array still counts as nullable usage.
        Assert.Contains("PickArray<T>", generated);
    }

    [Fact]
    public async Task Init_only_property_overrides_keep_their_init_accessor()
    {
        using var manager = await OpenAsync();
        var generated = await ApplyOverrideActionAsync(manager);

        // An `init` accessor regenerated as `set` would not compile against the
        // base declaration. Match the accessor itself, not the substring: "init"
        // occurs inside plenty of unrelated identifiers.
        var start = generated.IndexOf("public override int Seed", StringComparison.Ordinal);
        Assert.True(start >= 0, "the init-only property must be overridden");

        // Bound the search to this one declaration so a `set` elsewhere in the
        // file cannot mask a wrongly regenerated accessor here.
        var rest = generated[start..];
        var next = rest.IndexOf("public override", 1, StringComparison.Ordinal);
        var declaration = next < 0 ? rest : rest[..next];

        Assert.Contains("init", declaration);
        Assert.DoesNotContain("set", declaration);
    }

    /// <summary>Apply "Generate overrides..." on a type and return the new file text.</summary>
    private async Task<string> ApplyOverrideActionAsync(
        WorkspaceManager manager,
        string anchor = "public class Square : Shape"
    )
    {
        var actions = Unwrap(await CodeActionsOnTypeAsync(manager, anchor));
        var action = actions.Find(item => item.Title == "Generate overrides...");
        Assert.NotNull(action);

        var edit = Unwrap(await manager.ResolveCodeActionAsync(action.Id));
        var document = Assert.Single(edit.DocumentChanges);
        Assert.Equal(_sourcePath, document.FilePath);
        Assert.NotEmpty(document.Edits);
        return ApplyEdits(Source, document.Edits);
    }

    private async Task<Outcome.Result<List<CodeActionItem>, string>> CodeActionsOnTypeAsync(
        WorkspaceManager manager,
        string anchor
    )
    {
        var token = anchor.Split(' ')[2];
        var (line, character) = Locate(anchor, token);
        return await manager.GetCodeActionsAsync(_sourcePath, line, character, line, character);
    }

    /// <summary>Zero-based line/character of <paramref name="token"/> on the anchor line.</summary>
    private static (int Line, int Character) Locate(string anchor, string token)
    {
        var lines = Source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var index = Array.FindIndex(
            lines,
            value => value.Contains(anchor, StringComparison.Ordinal)
        );
        Assert.True(index >= 0, $"anchor not found: {anchor}");
        var character = lines[index].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"token not found on anchor line: {token}");
        return (index, character);
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
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

    private static string ApplyEdits(string source, IEnumerable<TextEditResult> edits)
    {
        var text = SourceText.From(source);
        var changes = edits.Select(edit => new TextChange(EditSpan(text, edit), edit.NewText));
        return text.WithChanges(changes).ToString();
    }

    private static TextSpan EditSpan(SourceText text, TextEditResult edit)
    {
        var start = text.Lines.GetPosition(new LinePosition(edit.StartLine, edit.StartCharacter));
        var end = text.Lines.GetPosition(new LinePosition(edit.EndLine, edit.EndCharacter));
        return TextSpan.FromBounds(start, end);
    }
}
