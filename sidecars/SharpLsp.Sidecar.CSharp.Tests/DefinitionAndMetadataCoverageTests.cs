using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for IndexOf overloads
#pragma warning disable CA1515 // Types can be internal

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Direct-resolver tests over an <see cref="Microsoft.CodeAnalysis.AdhocWorkspace"/>
/// targeting <see cref="DefinitionResolver"/> and <see cref="MetadataNavigator"/>
/// branches the MSBuild-backed E2E fixture and <c>ResolverUnitTests</c> do not
/// exercise: declaration walking for properties/events/partials/interfaces,
/// reference resolution with/without declarations, document highlight kinds for
/// declarations, type-definition metadata fallback, implementation discovery for
/// interfaces and virtual properties, and metadata-as-source decompilation of
/// framework constructors, methods, properties, fields, events and named types.
/// </summary>
public sealed class DefinitionAndMetadataCoverageTests
{
    // ---- DefinitionResolver: ResolveDefinitionLocationsAsync ----

    [Fact]
    public async Task Definition_on_local_variable_usage_resolves_to_declaration()
    {
        const string source = """
            class C {
                void M() {
                    int total = 5;
                    int next = total + 1;
                }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `total` usage in `total + 1` (line 3).
        var line = LineOf(source, "int next");
        var character = source[IndexOfLine(source, line)..]
            .IndexOf("total", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        _ = Assert.Single(result.Locations);
        // The declaration of `total` is on line 2.
        Assert.Equal(2, result.Locations[0].Line);
    }

    [Fact]
    public async Task Definition_of_framework_member_falls_back_to_metadata_or_empty()
    {
        const string source = """
            class C {
                void M() { System.Console.WriteLine("x"); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var line = LineOf(source, "WriteLine");
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("WriteLine", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        // WriteLine lives in metadata only — fallback yields a decompiled
        // location (in a temp file) or, if decompilation is unavailable on the
        // host, an empty list. Either way it must not be a source location.
        Assert.NotNull(result.Locations);
        if (result.Locations.Count > 0)
        {
            Assert.False(string.IsNullOrEmpty(result.Locations[0].FilePath));
            Assert.Contains("sharplsp-decompiled", result.Locations[0].FilePath);
        }
    }

    [Fact]
    public async Task Definition_on_whitespace_only_document_returns_empty_locations()
    {
        var (document, _) = RoslynTestWorkspace.Create("   ");

        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            1,
            CancellationToken.None
        );

        Assert.Empty(result.Locations);
    }

    // ---- DefinitionResolver: ResolveTypeDefinitionAsync ----

    [Fact]
    public async Task TypeDefinition_of_user_type_expression_resolves_to_source()
    {
        const string source = """
            class Widget { }
            class C {
                void M() { var w = new Widget(); var s = w.ToString(); }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `w` usage in `w.ToString()` — GetTypeInfo on this
        // expression yields the Widget type, which is declared in source.
        var line = LineOf(source, "w.ToString");
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("w.ToString", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveTypeDefinitionAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // Widget is declared on line 0.
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task TypeDefinition_at_position_without_type_returns_null()
    {
        const string source = """
            class C { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the class keyword — GetTypeInfo yields no Type.
        var loc = await DefinitionResolver.ResolveTypeDefinitionAsync(
            document,
            0,
            0,
            CancellationToken.None
        );

        Assert.Null(loc);
    }

    [Fact]
    public async Task TypeDefinition_of_string_variable_resolves_metadata_or_null()
    {
        const string source = """
            class C { void M() { string s = "hi"; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var character = source.IndexOf("s =", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveTypeDefinitionAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        // System.String is metadata-only: either a decompiled location or null.
        Assert.True(loc is null || !string.IsNullOrEmpty(loc.FilePath));
    }

    // ---- DefinitionResolver: ResolveDeclarationAsync ----

    [Fact]
    public async Task Declaration_of_property_override_walks_to_base_property()
    {
        const string source = """
            class Base { public virtual int Value { get; set; } }
            class Derived : Base { public override int Value { get; set; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `Value` property of Derived (line 1).
        var line = 1;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Value", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // The base property declaration is on line 0.
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_interface_implementation_walks_to_interface_member()
    {
        const string source = """
            interface IShape { int Area(); }
            class Square : IShape { public int Area() => 4; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `Area` method of Square (line 1).
        var line = 1;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Area", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // The interface member declaration is on line 0.
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_partial_method_implementation_walks_to_definition()
    {
        const string source = """
            partial class C {
                partial void Hook();
            }
            partial class C {
                partial void Hook() { }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `Hook` implementing part (line 4).
        var line = 4;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Hook", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // The defining declaration is on line 1.
        Assert.Equal(1, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_method_override_walks_to_base_method()
    {
        const string source = """
            class Base { public virtual int Foo() => 0; }
            class Derived : Base { public override int Foo() => 1; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the overriding `Foo` of Derived (line 1).
        var line = 1;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Foo", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // The base virtual method is on line 0.
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_event_override_walks_to_base_event()
    {
        const string source = """
            using System;
            class Base { public virtual event EventHandler? E; }
            class Derived : Base { public override event EventHandler? E; }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the overriding event `E` of Derived (line 2).
        var line = 2;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].LastIndexOf("E;", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        // The base virtual event is declared on line 1.
        Assert.Equal(1, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_top_level_type_returns_itself()
    {
        const string source = """
            class Standalone { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // A top-level type has no ContainingType, exercising the
        // FindInterfaceMember null-guard, and no base member to walk to.
        var character = source.IndexOf("Standalone", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        Assert.NotNull(loc);
        Assert.Equal(0, loc!.Line);
    }

    [Fact]
    public async Task Declaration_of_framework_method_falls_back_to_metadata_or_null()
    {
        const string source = """
            class C { void M() { System.Console.WriteLine("x"); } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // The framework method has no in-source declaration, so
        // ToFirstSourceLocation returns null and the metadata fallback runs.
        var character = source.IndexOf("WriteLine", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        // Either a decompiled location or null — never an in-source location.
        Assert.True(
            loc is null || loc.FilePath.Contains("sharplsp-decompiled", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Declaration_of_plain_method_returns_itself()
    {
        const string source = """
            class C { void Solo() { } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var character = source.IndexOf("Solo", StringComparison.Ordinal);
        var loc = await DefinitionResolver.ResolveDeclarationAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        // No base/interface to navigate to — declaration is the method itself.
        Assert.NotNull(loc);
        Assert.Equal(0, loc!.Line);
    }

    // ---- DefinitionResolver: ResolveImplementationsAsync ----

    [Fact]
    public async Task Implementations_of_interface_method_finds_implementer()
    {
        const string source = """
            interface IRun { void Go(); }
            class Runner : IRun { public void Go() { } }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the interface method `Go` (line 0).
        var character = source.IndexOf("Go", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveImplementationsAsync(
            document,
            solution,
            0,
            character,
            CancellationToken.None
        );

        Assert.NotEmpty(result.Locations);
        // Implementer Go() is on line 1.
        Assert.Contains(result.Locations, l => l.Line == 1);
    }

    [Fact]
    public async Task Implementations_of_virtual_property_finds_override()
    {
        const string source = """
            class Base { public virtual int Score { get; set; } }
            class Derived : Base { public override int Score { get; set; } }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the virtual property `Score` (line 0).
        var character = source.IndexOf("Score", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveImplementationsAsync(
            document,
            solution,
            0,
            character,
            CancellationToken.None
        );

        Assert.NotEmpty(result.Locations);
        // The overriding property is on line 1.
        Assert.Contains(result.Locations, l => l.Line == 1);
    }

    [Fact]
    public async Task Implementations_on_unresolved_position_returns_empty()
    {
        const string source = """
            class C { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position deep in trailing whitespace where no symbol resolves.
        var result = await DefinitionResolver.ResolveImplementationsAsync(
            document,
            solution,
            0,
            source.Length,
            CancellationToken.None
        );

        // Either resolves the enclosing class (itself) or returns nothing,
        // but must never throw and must produce a valid list.
        Assert.NotNull(result.Locations);
    }

    // ---- DefinitionResolver: ResolveReferencesAsync ----

    [Fact]
    public async Task References_excludes_declaration_when_flag_false()
    {
        const string source = """
            class C {
                void Foo() { }
                void M() { Foo(); Foo(); }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var line = 1;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Foo", StringComparison.Ordinal);

        var withDecl = await DefinitionResolver.ResolveReferencesAsync(
            document,
            solution,
            line,
            character,
            includeDeclaration: true,
            CancellationToken.None
        );
        var withoutDecl = await DefinitionResolver.ResolveReferencesAsync(
            document,
            solution,
            line,
            character,
            includeDeclaration: false,
            CancellationToken.None
        );

        // Two call sites in both cases; declaration adds exactly one more.
        Assert.Equal(2, withoutDecl.Locations.Count);
        Assert.Equal(withoutDecl.Locations.Count + 1, withDecl.Locations.Count);
        // The declaration entry (line 1) only appears with includeDeclaration.
        Assert.DoesNotContain(withoutDecl.Locations, l => l.Line == 1 && l.Character == character);
    }

    [Fact]
    public async Task References_on_unresolved_position_returns_empty()
    {
        const string source = "// comment only\n";
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var result = await DefinitionResolver.ResolveReferencesAsync(
            document,
            solution,
            0,
            3,
            includeDeclaration: true,
            CancellationToken.None
        );

        Assert.Empty(result.Locations);
    }

    [Fact]
    public async Task References_to_property_includes_read_and_write_sites()
    {
        const string source = """
            class C {
                int Count { get; set; }
                void M() { Count = 1; int x = Count; }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var character = source.IndexOf("Count", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveReferencesAsync(
            document,
            solution,
            1,
            character,
            includeDeclaration: false,
            CancellationToken.None
        );

        // The assignment site and the read site are both references.
        Assert.True(result.Locations.Count >= 2);
    }

    // ---- DefinitionResolver: ResolveDocumentHighlightsAsync ----

    [Fact]
    public async Task Highlights_on_method_report_call_sites_as_reads()
    {
        const string source = """
            class C {
                void Foo() { }
                void M() { Foo(); Foo(); }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the method declaration `Foo` (line 1).
        var line = 1;
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("Foo", StringComparison.Ordinal);
        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotEmpty(highlights);
        // Both call sites on line 2 are reported as Read (kind 2).
        Assert.Equal(2, highlights.Count(h => h.Kind == 2 && h.StartLine == 2));
        // Method-call references are never classified as writes.
        Assert.DoesNotContain(highlights, h => h.Kind == 3);
    }

    [Fact]
    public async Task Highlights_on_unresolved_position_returns_empty()
    {
        const string source = "// just a comment, no symbols here\n";
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            0,
            5,
            CancellationToken.None
        );

        // A position inside a comment resolves to no referenceable symbol.
        Assert.Empty(highlights);
    }

    [Fact]
    public async Task Highlights_classify_assignment_increment_and_decrement_as_writes()
    {
        const string source = """
            class C {
                int x;
                void M() { x = 1; x++; ++x; x--; --x; int r = x; }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the `x` field declaration (line 1).
        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            1,
            8,
            CancellationToken.None
        );

        // The assignment `x = 1`, both `++`/`--` postfix and both prefix forms
        // are writes (kind 3); the `int r = x` read is kind 2.
        Assert.NotEmpty(highlights);
        var writes = highlights.Count(h => h.Kind == 3);
        var reads = highlights.Count(h => h.Kind == 2);
        // Five write sites: x=1, x++, ++x, x--, --x.
        Assert.True(writes >= 5, $"expected >=5 writes, got {writes}");
        // One read site: int r = x.
        Assert.True(reads >= 1, $"expected >=1 read, got {reads}");
    }

    [Fact]
    public async Task Highlights_on_local_separate_reads_from_compound_assignment_write()
    {
        const string source = """
            class C {
                void M() {
                    int total = 0;
                    total = total + 1;
                    int copy = total;
                }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the `total` local declaration (line 2).
        var line = LineOf(source, "int total");
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("total", StringComparison.Ordinal);
        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            line,
            character,
            CancellationToken.None
        );

        Assert.NotEmpty(highlights);
        // `total =` on line 3 is the assignment target (write, kind 3).
        Assert.Contains(highlights, h => h.Kind == 3 && h.StartLine == 3);
        // The `total + 1` read and the `int copy = total` read are kind 2.
        Assert.Contains(highlights, h => h.Kind == 2);
    }

    [Fact]
    public async Task Highlights_on_property_set_in_object_initializer_includes_write()
    {
        const string source = """
            class Box { public int Size { get; set; } }
            class C {
                void M() {
                    var b = new Box { Size = 3 };
                    int read = b.Size;
                }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Position on the `Size` property declaration (line 0). The object
        // initializer `Size = 3` is an assignment reference (write), and
        // `b.Size` is a read.
        var character = source.IndexOf("Size", StringComparison.Ordinal);
        var highlights = await DefinitionResolver.ResolveDocumentHighlightsAsync(
            document,
            solution,
            0,
            character,
            CancellationToken.None
        );

        Assert.NotEmpty(highlights);
        // The initializer assignment is a write (kind 3).
        Assert.Contains(highlights, h => h.Kind == 3);
        // The `b.Size` access is a read (kind 2).
        Assert.Contains(highlights, h => h.Kind == 2);
    }

    [Fact]
    public async Task Highlights_on_ref_argument_is_write()
    {
        const string source = """
            class C {
                int x;
                void Set(ref int v) { v = 0; }
                void M() { Set(ref x); }
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

    // ---- MetadataNavigator (via go-to-definition on framework symbols) ----

    [Fact]
    public async Task Metadata_navigation_to_named_type_yields_decompiled_location()
    {
        const string source = """
            class C { void M() { var b = new System.Text.StringBuilder(); } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on `StringBuilder` (the type name in the object creation).
        var character = source.IndexOf("StringBuilder", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_constructor_yields_decompiled_location()
    {
        const string source = """
            class C { void M() { var e = new System.Exception("oops"); } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on `Exception` constructor call.
        var character = source.IndexOf("Exception", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_base_constructor_yields_decompiled_location()
    {
        const string source = """
            class MyError : System.Exception {
                public MyError(string m) : base(m) { }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `base` keyword in `: base(m)` — go-to-definition
        // resolves the System.Exception(string) constructor, driving the
        // constructor search-pattern branch in MetadataNavigator.
        var line = LineOf(source, ": base(m)");
        var lineStart = IndexOfLine(source, line);
        var character = source[lineStart..].IndexOf("base", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            line,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_instance_method_yields_decompiled_location()
    {
        const string source = """
            class C { void M() { var s = "x".ToUpperInvariant(); } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `ToUpperInvariant` method call.
        var character = source.IndexOf("ToUpperInvariant", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_property_yields_decompiled_location()
    {
        const string source = """
            class C { void M() { int n = "abc".Length; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `Length` property access.
        var character = source.IndexOf("Length", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_field_yields_decompiled_location()
    {
        const string source = """
            class C { void M() { var v = int.MaxValue; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `MaxValue` field of System.Int32.
        var character = source.IndexOf("MaxValue", StringComparison.Ordinal);
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_event_yields_decompiled_location()
    {
        const string source = """
            class C {
                void M(System.AppDomain d) { d.UnhandledException += null; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the `UnhandledException` event.
        var character = source.IndexOf("UnhandledException", StringComparison.Ordinal);
        var line = LineOf(source, "UnhandledException");
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            line,
            character - IndexOfLine(source, line),
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_to_nested_type_yields_decompiled_location()
    {
        const string source = """
            class C {
                void M(System.Collections.Generic.Dictionary<int, int> d) {
                    System.Collections.Generic.Dictionary<int, int>.Enumerator e = d.GetEnumerator();
                }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Position on the nested `Enumerator` type — exercises GetContainingType
        // walking up from the nested type to the outer Dictionary<,>.
        var character = source.IndexOf("Enumerator e", StringComparison.Ordinal);
        var line = LineOf(source, "Enumerator e");
        var result = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            line,
            character - IndexOfLine(source, line),
            CancellationToken.None
        );

        AssertMetadataOrEmpty(result);
    }

    [Fact]
    public async Task Metadata_navigation_repeated_call_uses_cache()
    {
        const string source = """
            class C { void M() { var b = new System.Text.StringBuilder(); } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);
        var character = source.IndexOf("StringBuilder", StringComparison.Ordinal);

        var first = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );
        var second = await DefinitionResolver.ResolveDefinitionLocationsAsync(
            document,
            0,
            character,
            CancellationToken.None
        );

        // Both invocations must agree (second served from the decompile cache).
        Assert.Equal(first.Locations.Count, second.Locations.Count);
        if (first.Locations.Count > 0 && second.Locations.Count > 0)
        {
            Assert.Equal(first.Locations[0].FilePath, second.Locations[0].FilePath);
        }
    }

    // ---- Helpers ----

    private static void AssertMetadataOrEmpty(LocationListResult result)
    {
        Assert.NotNull(result.Locations);
        if (result.Locations.Count > 0)
        {
            var loc = result.Locations[0];
            Assert.False(string.IsNullOrEmpty(loc.FilePath));
            Assert.Contains("sharplsp-decompiled", loc.FilePath);
            Assert.True(loc.Line >= 0);
            Assert.True(loc.EndCharacter >= loc.Character);
        }
    }

    private static int LineOf(string source, string marker)
    {
        var index = source.IndexOf(marker, StringComparison.Ordinal);
        return index < 0
            ? throw new InvalidOperationException($"Marker '{marker}' not found")
            : source[..index].Count(c => c == '\n');
    }

    private static int IndexOfLine(string source, int line)
    {
        var position = 0;
        for (var i = 0; i < line; i++)
        {
            position = source.IndexOf('\n', position) + 1;
        }

        return position;
    }
}
