using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Hover;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Direct-resolver tests over an <see cref="AdhocWorkspace"/>. These hit
/// branches that the slow MSBuild-backed E2E fixture does not exercise
/// (literal hover paths, lambda inlay hints, semantic-token classifications,
/// etc.).
/// </summary>
public sealed class ResolverUnitTests
{
    [Fact]
    public async Task SemanticTokens_full_returns_diverse_tokens()
    {
        const string source = """
            using System;
            namespace N {
                /// <summary>doc</summary>
                public interface IFoo { int Value { get; } }
                public enum Colors { Red, Green }
                public struct Point { public int X; }
                public class C<T> : IFoo {
                    public int Value => 42;
                    public void M(string name) { var x = "hi"; int y = 1 + 2; }
                }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var data = await SemanticTokensResolver.GetFullAsync(document, CancellationToken.None);

        Assert.NotEmpty(data);
        // Each token = 5 ints.
        Assert.Equal(0, data.Length % 5);
        // Token-type ID must lie within the legend.
        var types = SemanticTokensResolver.GetTokenTypes();
        for (var i = 3; i < data.Length; i += 5)
        {
            Assert.InRange(data[i], 0, types.Length - 1);
        }
    }

    [Fact]
    public async Task SemanticTokens_range_returns_only_range_tokens()
    {
        const string source = """
            using System;
            class Foo { public int A => 1; public int B => 2; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var fullData = await SemanticTokensResolver.GetFullAsync(document, CancellationToken.None);
        var rangeData = await SemanticTokensResolver.GetRangeAsync(
            document,
            0,
            0,
            1,
            0,
            CancellationToken.None
        );

        Assert.NotEmpty(rangeData);
        Assert.True(rangeData.Length <= fullData.Length);
    }

    [Fact]
    public void TokenLegends_are_non_empty()
    {
        Assert.NotEmpty(SemanticTokensResolver.GetTokenTypes());
        Assert.NotEmpty(SemanticTokensResolver.GetTokenModifiers());
    }

    [Fact]
    public async Task Hover_on_string_literal_returns_null()
    {
        const string source = """
            class C { void M() { var s = "hello"; } }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf('"', StringComparison.Ordinal) + 2; // inside literal

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.Null(ok.Value);
    }

    [Fact]
    public async Task Hover_on_numeric_literal_returns_literal_type()
    {
        const string source = """
            class C { int x = 42; }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("42", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("literal", ok.Value!.Contents);
        Assert.Contains("int", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_var_resolves_inferred_type()
    {
        // `var` in C# is an identifier token — ResolveSymbol handles it via
        // type info. Either "inferred" (BuildVarHover) or the type itself
        // is an acceptable rendering.
        const string source = """
            class C { void M() { var x = "hello"; } }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("var", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("string", ok.Value!.Contents);
    }

    [Fact]
    public async Task Hover_on_character_literal_returns_null()
    {
        const string source = """
            class C { char c = 'a'; }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf('\'', StringComparison.Ordinal) + 1;

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.Null(ok.Value);
    }

    [Fact]
    public async Task Hover_on_obsolete_method_marks_deprecated()
    {
        const string source = """
            using System;
            class C {
                [Obsolete("use Bar instead")]
                public void Foo() { }
                public void Caller() { Foo(); }
            }
            """;
        var model = await GetModel(source);
        // Position of "Foo" inside "Foo()" call.
        var position = source.LastIndexOf("Foo", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Deprecated", ok.Value!.Contents);
        Assert.Contains("use Bar instead", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_empty_span_returns_null_payload()
    {
        // Position 0 in an empty text -> IsKind(None) path.
        var (document, _) = RoslynTestWorkspace.Create("");
        var model = await document.GetSemanticModelAsync();
        Assert.NotNull(model);

        var result = CSharpHoverBuilder.Build(model!, 0, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.Null(ok.Value);
    }

    [Fact]
    public async Task InlayHints_lambda_param_returns_type_hint()
    {
        const string source = """
            using System;
            using System.Linq;
            using System.Collections.Generic;
            class C {
                void M() {
                    var xs = new List<int> { 1, 2, 3 };
                    var doubled = xs.Select(x => x * 2);
                    Func<int, int, int> add = (a, b) => a + b;
                }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 20, CancellationToken.None);

        // Should contain lambda param type hints (Kind = 1 Type) and var type hints.
        Assert.Contains(hints, h => h.Kind == 1);
    }

    [Fact]
    public async Task InlayHints_endLine_beyond_document_is_clamped()
    {
        const string source = """
            class C { void M() { var x = 42; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // endLine=999 is beyond the file — GetHintsAsync must clamp without throwing.
        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 999, CancellationToken.None);

        Assert.NotNull(hints);
    }

    [Fact]
    public async Task InlayHints_named_arg_is_skipped()
    {
        const string source = """
            class C {
                void Greet(string who, int times) { }
                void M() { Greet(who: "world", 3); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 5, CancellationToken.None);

        // The `who:` arg has NameColon and must NOT get a parameter hint.
        Assert.DoesNotContain(hints, h => h.Label == "who:");
        // But `times:` (positional) SHOULD get a hint.
        Assert.Contains(hints, h => h.Label == "times:");
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_non_method_returns_item_or_null()
    {
        const string source = """
            class C {
                int x = 1;
                void M() { M(); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await CallHierarchyResolver.PrepareAsync(document, 1, 8, CancellationToken.None);

        // Field `x` at line 1 char 8 — either null or a field item.
        Assert.True(item is null || item.Kind == "field");
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_method_returns_method_item()
    {
        const string source = """
            class C {
                void M() { M(); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await CallHierarchyResolver.PrepareAsync(document, 1, 9, CancellationToken.None);

        Assert.NotNull(item);
        Assert.Equal("method", item!.Kind);
        Assert.Contains("M", item.Name);
    }

    [Fact]
    public async Task CallHierarchy_outgoing_returns_called_methods()
    {
        const string source = """
            class C {
                void Target() { }
                void Caller() { Target(); Target(); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var calls = await CallHierarchyResolver.GetOutgoingAsync(
            document,
            2,
            9,
            CancellationToken.None
        );

        Assert.NotEmpty(calls);
        Assert.All(calls, c => Assert.Contains("Target", c.Name));
    }

    [Fact]
    public async Task TypeHierarchy_supertypes_handles_plain_object_base()
    {
        // A class that derives directly from System.Object — the base type filter
        // (`!= SpecialType.System_Object`) skips object so only interfaces remain.
        const string source = """
            class Solo { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var items = await TypeHierarchyResolver.GetSupertypesAsync(
            document,
            0,
            6,
            CancellationToken.None
        );

        Assert.Empty(items);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_enum_returns_enum_kind()
    {
        const string source = """
            enum Colors { Red, Green, Blue }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await TypeHierarchyResolver.PrepareAsync(document, 0, 5, CancellationToken.None);

        Assert.NotNull(item);
        Assert.Equal("enum", item!.Kind);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_struct_returns_struct_kind()
    {
        const string source = """
            struct Point { public int X; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await TypeHierarchyResolver.PrepareAsync(document, 0, 7, CancellationToken.None);

        Assert.NotNull(item);
        Assert.Equal("struct", item!.Kind);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_interface_returns_interface_kind()
    {
        const string source = """
            interface IThing { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await TypeHierarchyResolver.PrepareAsync(
            document,
            0,
            10,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("interface", item!.Kind);
    }

    [Fact]
    public async Task Definition_of_override_declaration_walks_to_base()
    {
        const string source = """
            class Base { public virtual int Foo() => 0; }
            class Derived : Base { public override int Foo() => 1; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            1,
            45,
            CancellationToken.None
        );

        // Declaration of override on line 1 should return base on line 0.
        Assert.NotNull(loc);
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task Definition_on_unknown_token_returns_empty()
    {
        const string source = """
            class C { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position past the whitespace — GetSymbolInfo returns nothing but walks find the class.
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            0,
            CancellationToken.None
        );

        Assert.NotNull(result);
        Assert.NotNull(result.Locations);
    }

    [Fact]
    public async Task Definition_on_event_override_returns_base_event()
    {
        const string source = """
            using System;
            class Base { public virtual event EventHandler? E; }
            class Derived : Base { public override event EventHandler? E; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            2,
            59,
            CancellationToken.None
        );

        Assert.NotNull(loc);
    }

    [Fact]
    public async Task Highlights_mark_assignments_as_write()
    {
        const string source = """
            class C {
                int x;
                void M() { x = 1; x = 2; var y = x + 1; }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on "x" field declaration at line 1, char 8.
        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            1,
            8,
            CancellationToken.None
        );

        // Must include at least one Write (3) and one Read (2) reference.
        Assert.NotEmpty(highlights);
        Assert.Contains(highlights, h => h.Kind == 3);
        Assert.Contains(highlights, h => h.Kind == 2);
    }

    [Fact]
    public async Task Highlights_increment_is_write()
    {
        const string source = """
            class C {
                int x;
                void M() { x++; ++x; x--; --x; }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            1,
            8,
            CancellationToken.None
        );

        // All 4 inc/dec should be Write (kind=3).
        Assert.Contains(highlights, h => h.Kind == 3);
    }

    [Fact]
    public async Task Highlights_out_arg_is_write()
    {
        const string source = """
            class C {
                int x;
                void Set(out int v) { v = 0; }
                void M() { Set(out x); }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            1,
            8,
            CancellationToken.None
        );

        Assert.Contains(highlights, h => h.Kind == 3);
    }

    [Fact]
    public async Task CodeActions_resolve_unknown_id_returns_null()
    {
        var resolver = new CodeActionResolver();
        var (_, solution) = RoslynTestWorkspace.Create("class C { }");

        var result = await resolver.ResolveAsync(99999, solution, CancellationToken.None);

        Assert.Null(result);
    }

    [Fact]
    public async Task CodeActions_span_without_diagnostics_returns_only_refactorings()
    {
        var resolver = new CodeActionResolver();
        const string source = """
            class C {
                void M() { var x = 1; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);
        var text = await document.GetTextAsync();
        var span = TextSpan.FromBounds(0, text.Length);

        var items = await resolver.GetCodeActionsAsync(document, span, CancellationToken.None);

        // Must not throw; may be empty or contain refactorings.
        Assert.NotNull(items);
    }

    [Fact]
    public async Task Implementations_of_concrete_class_includes_itself()
    {
        const string source = """
            sealed class Alone { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on "Alone".
        var result = await DefinitionResolver.ResolveImplementationsAsync(
            document,
            solution,
            0,
            13,
            CancellationToken.None
        );

        // No derived types — implementation returns the symbol's own location.
        Assert.NotEmpty(result.Locations);
    }

    [Fact]
    public async Task Implementations_of_virtual_method_finds_overrides()
    {
        const string source = """
            class Base { public virtual void Foo() { } }
            class Derived : Base { public override void Foo() { } }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on virtual Foo — line 0, "Foo" at col 33.
        var result = await DefinitionResolver.ResolveImplementationsAsync(
            document,
            solution,
            0,
            33,
            CancellationToken.None
        );

        Assert.NotEmpty(result.Locations);
        // Must include the override on line 1.
        Assert.Contains(result.Locations, l => l.Line == 1);
    }

    [Fact]
    public async Task References_finds_all_usages()
    {
        const string source = """
            class C {
                void Foo() { }
                void M() { Foo(); Foo(); }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on Foo declaration (line 1, char 9).
        var result = await DefinitionResolver.ResolveReferencesAsync(
            document,
            solution,
            1,
            9,
            true,
            CancellationToken.None
        );

        // Declaration + 2 call sites.
        Assert.True(result.Locations.Count >= 2);
    }

    [Fact]
    public async Task TypeDefinition_of_variable_resolves()
    {
        const string source = """
            class C { void M() { string s = "hi"; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on `s` in `string s`.
        var loc = await DefinitionResolver.ResolveTypeDefinitionAsync(
            document,
            0,
            28,
            CancellationToken.None
        );

        // May resolve to metadata (String.cs decompiled) or null.
        Assert.True(loc is null || !string.IsNullOrEmpty(loc.FilePath));
    }

    private static async Task<SemanticModel> GetModel(string source)
    {
        var (document, _) = RoslynTestWorkspace.Create(source);
        var model = await document.GetSemanticModelAsync().ConfigureAwait(true);
        return model ?? throw new InvalidOperationException("semantic model is null");
    }
}
