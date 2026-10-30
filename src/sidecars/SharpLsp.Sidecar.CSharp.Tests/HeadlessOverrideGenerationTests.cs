using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

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
        using System.Collections.Generic;

        namespace Overrides;

        public abstract class Shape
        {
            public abstract int Compute(int seed);

            public abstract T? Pick<T>(T? value);

            public abstract TRef? PickReference<TRef>(TRef? value)
                where TRef : class;

            public abstract T[]? PickArray<T>(T?[] values);

            public abstract List<T?> PickList<T>(T value);

            public abstract void TakeList<T>(List<T> items);

            public abstract unsafe void TakePointer<T>(T*[] values)
                where T : unmanaged;

            public abstract unsafe void TakeCallback<T>(delegate*<T, void> callback)
                where T : unmanaged;

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

            public override void TakeList<T>(List<T> items) { }

            public override unsafe void TakePointer<T>(T*[] values) { }

            public override event EventHandler? Changed;
        }
        """;

    private readonly RefactoringProject _project = new(
        "Shapes",
        new Dictionary<string, string>
        {
            ["Shapes.cs"] = Source,
            ["Directory.Build.props"] = """
            <Project>
              <PropertyGroup>
                <AllowUnsafeBlocks>true</AllowUnsafeBlocks>
              </PropertyGroup>
            </Project>
            """,
        }
    );

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task Override_action_is_offered_on_a_type_that_leaves_members_unimplemented()
    {
        using var manager = await _project.OpenAsync();
        var actions = await CodeActionsOnTypeAsync(manager, "public class Square : Shape");
        Assert.Contains(actions, action => action.Title == "Generate overrides...");
    }

    /// <summary>
    /// Roslyn's own "Generate overrides..." needs a member picker a headless host does not
    /// have, so resolving it throws, and it shares the headless action's title. On
    /// <c>Shape</c>, whose base leaves nothing abstract, the headless action has nothing to
    /// generate, so NO "Generate overrides..." may be offered there. Where there is
    /// something to generate, exactly one is offered and it resolves (GitHub #201).
    /// </summary>
    [Fact]
    public async Task Only_the_headless_override_action_is_ever_offered()
    {
        using var manager = await _project.OpenAsync();
        var onShape = await CodeActionsOnTypeAsync(manager, "public abstract class Shape", "Shape");
        Assert.DoesNotContain(onShape, action => action.Title == "Generate overrides...");

        var onSquare = await CodeActionsOnTypeAsync(manager, "public class Square : Shape");
        var offered = Assert.Single(onSquare, action => action.Title == "Generate overrides...");
        var resolved = await manager.ResolveCodeActionAsync(offered.Id);
        Assert.False(resolved.IsError, resolved.Match(_ => "ok", error => error));
    }

    [Fact]
    public async Task Members_the_type_already_overrides_are_not_generated_again()
    {
        using var manager = await _project.OpenAsync();
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

        // A constructed generic parameter type (`List<T>`) is the shape that forces the
        // signature comparison down its named-type path: the base's `T` and the override's `T`
        // are distinct symbols, so reference equality alone reports "not overridden" and the
        // generator emits a duplicate member that breaks the build.
        Assert.Equal(1, CountOccurrences(circle, "TakeList<T>"));

        // A pointer parameter takes the signature comparison down its pointer path. The base's
        // `T*` and the override's `T*` are distinct symbols for the same reason `List<T>` is.
        Assert.Equal(1, CountOccurrences(circle, "TakePointer<T>"));

        // Events have no parameter list to compare, so an occupied event slot is matched on
        // kind and name alone. Regenerating one is a duplicate-member build break too.
        Assert.Equal(1, CountOccurrences(circle, "Changed"));

        // The members it has not overridden are still generated.
        Assert.Contains("override string Name", circle);
        Assert.Contains("override int this[int index]", circle);
        Assert.Contains("protected override void Reset()", circle);

        Assert.Empty(RefactoringProject.ParseErrors(generated));
    }

    private static int CountOccurrences(string source, string value)
    {
        return source.Split(value, StringSplitOptions.None).Length - 1;
    }

    [Fact]
    public async Task Applying_the_action_generates_compilable_overrides_for_every_member_shape()
    {
        using var manager = await _project.OpenAsync();
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
        Assert.Empty(RefactoringProject.ParseErrors(generated));
    }

    [Fact]
    public async Task Generic_overrides_carry_the_constraint_clause_their_nullability_requires()
    {
        using var manager = await _project.OpenAsync();
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

    /// <summary>
    /// A nullable type parameter nested inside a <em>constructed generic</em> argument
    /// (<c>List&lt;T?&gt;</c>) is nullable usage just as much as a bare <c>T?</c> is. Missing it
    /// drops the <c>where T : default</c> clause and the generated override does not compile
    /// against its base declaration.
    /// </summary>
    [Fact]
    public async Task Nullability_inside_a_constructed_generic_argument_forces_the_constraint()
    {
        using var manager = await _project.OpenAsync();
        var generated = await ApplyOverrideActionAsync(manager);

        // Bound to `Square`: the abstract declaration up in `Shape` carries the same signature.
        var square = generated[
            generated.IndexOf("public class Square", StringComparison.Ordinal)..
        ];
        var start = square.IndexOf("override List<T?> PickList<T>", StringComparison.Ordinal);
        Assert.True(start >= 0, "the constructed-generic member must be overridden");

        // Bound the assertion to this declaration: `where T : default` on some other member
        // would otherwise mask its absence here.
        var rest = square[start..];
        var next = rest.IndexOf("public override", 1, StringComparison.Ordinal);
        var declaration = next < 0 ? rest : rest[..next];
        Assert.Contains("where T : default", declaration);
    }

    [Fact]
    public async Task Init_only_property_overrides_keep_their_init_accessor()
    {
        using var manager = await _project.OpenAsync();
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

    /// <summary>
    /// Unsafe members are part of the override surface: a pointer array and a function pointer
    /// both have to be walked when deciding whether a type parameter is used nullably. An
    /// unhandled type shape there throws out of the whole action, so the user loses "Generate
    /// overrides..." on the entire type because of one unsafe member.
    /// </summary>
    [Fact]
    public async Task Unsafe_pointer_members_are_generated_rather_than_aborting_the_action()
    {
        using var manager = await _project.OpenAsync();
        var generated = await ApplyOverrideActionAsync(manager);

        var square = generated[
            generated.IndexOf("public class Square", StringComparison.Ordinal)..
        ];
        Assert.Contains("TakePointer<T>", square);
        Assert.Contains("TakeCallback<T>", square);

        // Neither is nullable usage, so neither may acquire a `where T : default` clause it
        // cannot legally carry — `T` is already `unmanaged`-constrained.
        Assert.DoesNotContain("where T : default", DeclarationOf(square, "TakePointer<T>"));
        Assert.DoesNotContain("where T : default", DeclarationOf(square, "TakeCallback<T>"));

        Assert.Empty(RefactoringProject.ParseErrors(generated));
    }

    /// <summary>The single generated declaration starting at <paramref name="anchor"/>.</summary>
    private static string DeclarationOf(string generated, string anchor)
    {
        var start = generated.IndexOf(anchor, StringComparison.Ordinal);
        Assert.True(start >= 0, $"member not generated: {anchor}");
        var rest = generated[start..];
        var next = rest.IndexOf("public override", 1, StringComparison.Ordinal);
        return next < 0 ? rest : rest[..next];
    }

    /// <summary>Apply "Generate overrides..." on a type and return the new file text.</summary>
    private async Task<string> ApplyOverrideActionAsync(
        WorkspaceManager manager,
        string anchor = "public class Square : Shape"
    )
    {
        var edit = await _project.ApplyAsync(
            manager,
            "Shapes.cs",
            anchor,
            anchor.Split(' ')[2],
            "Generate overrides..."
        );
        var document = Assert.Single(edit.DocumentChanges);
        Assert.Equal(_project.PathOf("Shapes.cs"), document.FilePath);
        Assert.NotEmpty(document.Edits);
        return _project.After(edit, "Shapes.cs");
    }

    private async Task<List<CodeActionItem>> CodeActionsOnTypeAsync(
        WorkspaceManager manager,
        string anchor,
        string? token = null
    )
    {
        return await _project.ActionsAtAsync(
            manager,
            "Shapes.cs",
            anchor,
            token ?? anchor.Split(' ')[2]
        );
    }
}
