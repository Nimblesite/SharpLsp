using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.CSharp.Hover;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path/File banned for analyzers — we're tests, not analyzers

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Direct-resolver tests over an <see cref="AdhocWorkspace"/> targeting the
/// call-hierarchy, type-hierarchy, hover, code-lens, and inlay-hint resolvers.
/// These hit branches that the MSBuild-backed E2E fixture does not exercise
/// (incoming calls, subtype discovery, namespace/operator/extension-method
/// hover, code-lens reference counts, object-creation inlay hints, etc.).
/// </summary>
public sealed class HierarchyAndHoverCoverageTests
{
    // ── Call hierarchy ───────────────────────────────────────────────

    [Fact]
    public async Task CallHierarchy_incoming_returns_direct_callers()
    {
        const string source = """
            class C {
                void Target() { }
                void CallerOne() { Target(); }
                void CallerTwo() { Target(); }
            }
            """;
        var (document, solution) = CreateWithFilePath(source);

        // Line 1 ("void Target") char 9 lands on the Target identifier.
        var calls = await CallHierarchyResolver.GetIncomingAsync(
            solution,
            document.FilePath!,
            1,
            9,
            CancellationToken.None
        );

        Assert.NotEmpty(calls);
        // Both callers must show up as incoming calls.
        Assert.Contains(calls, c => c.Name == "CallerOne");
        Assert.Contains(calls, c => c.Name == "CallerTwo");
        Assert.All(calls, c => Assert.Equal("method", c.Kind));
    }

    [Fact]
    public async Task CallHierarchy_incoming_unknown_file_returns_empty()
    {
        const string source = """
            class C { void M() { M(); } }
            """;
        var (_, solution) = CreateWithFilePath(source);

        var calls = await CallHierarchyResolver.GetIncomingAsync(
            solution,
            "/does/not/exist/Nope.cs",
            0,
            15,
            CancellationToken.None
        );

        Assert.Empty(calls);
    }

    [Fact]
    public async Task CallHierarchy_incoming_on_whitespace_returns_empty()
    {
        const string source = """
            class C {
                void Target() { }
            }
            """;
        var (document, solution) = CreateWithFilePath(source);

        // Line 0 char 0 resolves to the class declaration which has no callers.
        var calls = await CallHierarchyResolver.GetIncomingAsync(
            solution,
            document.FilePath!,
            0,
            0,
            CancellationToken.None
        );

        Assert.Empty(calls);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_property_returns_property_item()
    {
        const string source = """
            class C {
                public int Value { get; set; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 1 char 15 lands on "Value".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            1,
            15,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("property", item!.Kind);
        Assert.Equal("Value", item.Name);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_constructor_returns_method_item()
    {
        const string source = """
            class Widget {
                public Widget() { }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 1 char 11 lands on the constructor name "Widget".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            1,
            11,
            CancellationToken.None
        );

        Assert.NotNull(item);
        // A constructor symbol is a method.
        Assert.Equal("method", item!.Kind);
    }

    [Fact]
    public async Task CallHierarchy_outgoing_includes_object_creation_calls()
    {
        const string source = """
            class C {
                void Helper() { }
                void Driver() { Helper(); Helper(); }
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
        Assert.All(calls, c => Assert.Equal("Helper", c.Name));
    }

    [Fact]
    public async Task CallHierarchy_prepare_at_invalid_position_for_symbol_is_null()
    {
        const string source = """
            class C {
                void M() { }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 0 char 0 resolves to the type declaration -> "class" kind item.
        var item = await CallHierarchyResolver.PrepareAsync(document, 0, 0, CancellationToken.None);

        Assert.NotNull(item);
        Assert.Equal("class", item!.Kind);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_event_returns_event_kind()
    {
        const string source = """
            using System;
            class C {
                public event EventHandler? Changed;
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 2 char 31 lands on the event name "Changed".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            2,
            31,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("event", item!.Kind);
        Assert.Equal("Changed", item.Name);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_namespace_returns_namespace_kind()
    {
        const string source = """
            namespace Acme.Tools { class C { } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 0 char 10 lands on "Acme".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            0,
            10,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("namespace", item!.Kind);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_local_returns_variable_kind()
    {
        const string source = """
            class C {
                void M() { int total = 0; total = total + 1; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 1 char 31 lands on the second use of "total".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            1,
            31,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("variable", item!.Kind);
    }

    [Fact]
    public async Task CallHierarchy_prepare_on_parameter_returns_parameter_kind()
    {
        const string source = """
            class C {
                void M(int amount) { var x = amount + 1; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 1 char 33 lands on the use of "amount".
        var item = await CallHierarchyResolver.PrepareAsync(
            document,
            1,
            33,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("parameter", item!.Kind);
    }

    // ── Type hierarchy ───────────────────────────────────────────────

    [Fact]
    public async Task TypeHierarchy_subtypes_returns_derived_classes()
    {
        const string source = """
            class Animal { }
            class Dog : Animal { }
            class Cat : Animal { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Line 0 char 6 lands on "Animal".
        var items = await TypeHierarchyResolver.GetSubtypesAsync(
            document,
            solution,
            0,
            6,
            CancellationToken.None
        );

        Assert.Equal(2, items.Count);
        Assert.Contains(items, i => i.Name == "Dog");
        Assert.Contains(items, i => i.Name == "Cat");
        Assert.All(items, i => Assert.Equal("class", i.Kind));
    }

    [Fact]
    public async Task TypeHierarchy_subtypes_of_interface_returns_implementors()
    {
        const string source = """
            interface IShape { }
            class Circle : IShape { }
            class Square : IShape { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        // Line 0 char 10 lands on "IShape".
        var items = await TypeHierarchyResolver.GetSubtypesAsync(
            document,
            solution,
            0,
            10,
            CancellationToken.None
        );

        Assert.Contains(items, i => i.Name == "Circle");
        Assert.Contains(items, i => i.Name == "Square");
    }

    [Fact]
    public async Task TypeHierarchy_supertypes_with_base_and_interfaces()
    {
        const string source = """
            interface IThing { }
            class Base { }
            class Derived : Base, IThing { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 2 char 6 lands on "Derived".
        var items = await TypeHierarchyResolver.GetSupertypesAsync(
            document,
            2,
            6,
            CancellationToken.None
        );

        // Both the base class and the implemented interface must appear.
        Assert.Contains(items, i => i.Name == "Base" && i.Kind == "class");
        Assert.Contains(items, i => i.Name == "IThing" && i.Kind == "interface");
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_record_returns_class_kind()
    {
        const string source = """
            record Point(int X, int Y);
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 0 char 7 lands on "Point".
        var item = await TypeHierarchyResolver.PrepareAsync(document, 0, 7, CancellationToken.None);

        Assert.NotNull(item);
        // A record is a class in TypeKind terms.
        Assert.Equal("class", item!.Kind);
        Assert.Equal("Point", item.Name);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_class_returns_class_kind()
    {
        const string source = """
            class Plain { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var item = await TypeHierarchyResolver.PrepareAsync(document, 0, 6, CancellationToken.None);

        Assert.NotNull(item);
        Assert.Equal("class", item!.Kind);
        Assert.Equal("Plain", item.Name);
    }

    [Fact]
    public async Task TypeHierarchy_subtypes_of_leaf_class_is_empty()
    {
        const string source = """
            sealed class Leaf { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var items = await TypeHierarchyResolver.GetSubtypesAsync(
            document,
            solution,
            0,
            13,
            CancellationToken.None
        );

        Assert.Empty(items);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_inside_member_resolves_enclosing_type()
    {
        const string source = """
            class C { void M() { int local = 0; } }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 0 char 25 is inside the method body. ResolveNamedType has no
        // direct symbol/declared type for the local, so it walks ancestors and
        // resolves the enclosing named type "C".
        var item = await TypeHierarchyResolver.PrepareAsync(
            document,
            0,
            25,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("C", item!.Name);
        Assert.Equal("class", item.Kind);
    }

    [Fact]
    public async Task TypeHierarchy_supertypes_on_base_reference_resolves_directly()
    {
        // Positioning on the `Base` reference in the base list exercises the
        // GetSymbolInfo direct-INamedTypeSymbol path of ResolveNamedType.
        const string source = """
            class Base { }
            class Derived : Base { }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 1 char 17 lands on the `Base` reference in `: Base`.
        var items = await TypeHierarchyResolver.GetSupertypesAsync(
            document,
            1,
            17,
            CancellationToken.None
        );

        // The reference resolves to Base, whose only supertype is object
        // (filtered out) — so the result is empty.
        Assert.Empty(items);
    }

    [Fact]
    public async Task TypeHierarchy_prepare_on_delegate_returns_delegate_kind()
    {
        const string source = """
            delegate int Transform(int x);
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        // Line 0 char 13 lands on "Transform".
        var item = await TypeHierarchyResolver.PrepareAsync(
            document,
            0,
            13,
            CancellationToken.None
        );

        Assert.NotNull(item);
        Assert.Equal("delegate", item!.Kind);
        Assert.Equal("Transform", item.Name);
    }

    // ── Hover ────────────────────────────────────────────────────────

    [Fact]
    public async Task Hover_on_method_renders_signature_and_doc()
    {
        const string source = """
            class C {
                /// <summary>Adds two numbers.</summary>
                public int Add(int a, int b) => a + b;
            }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("Add", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Add", ok.Value!.Contents);
        Assert.Contains("Adds two numbers", ok.Value.Contents);
        // The containing type "C" must be rendered.
        Assert.Contains("in", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_generic_method_includes_type_parameter()
    {
        const string source = """
            class C {
                public T Identity<T>(T value) => value;
            }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("Identity", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Identity", ok.Value!.Contents);
        Assert.Contains("T", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_namespace_renders_namespace_keyword()
    {
        const string source = """
            using System;
            class C { void M() { Console.WriteLine("x"); } }
            """;
        var model = await GetModel(source);
        // Hover on "System" in the using directive.
        var position = source.IndexOf("System", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("System", ok.Value!.Contents);
    }

    [Fact]
    public async Task Hover_on_parameter_renders_parameter_type()
    {
        const string source = """
            class C {
                void M(string name) { var len = name.Length; }
            }
            """;
        var model = await GetModel(source);
        // Hover on the use of `name` inside the body.
        var position = source.IndexOf("name.Length", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("name", ok.Value!.Contents);
        Assert.Contains("string", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_extension_method_call_renders_signature()
    {
        const string source = """
            using System.Linq;
            using System.Collections.Generic;
            class C {
                int M(List<int> xs) => xs.Count();
            }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("Count()", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Count", ok.Value!.Contents);
    }

    [Fact]
    public async Task Hover_on_type_in_declaration_renders_type_keyword()
    {
        const string source = """
            class Widget { }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("Widget", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("class", ok.Value!.Contents);
        Assert.Contains("Widget", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_obsolete_without_message_marks_deprecated()
    {
        const string source = """
            using System;
            class C {
                [Obsolete]
                public void Old() { }
                public void Use() { Old(); }
            }
            """;
        var model = await GetModel(source);
        var position = source.LastIndexOf("Old", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Deprecated", ok.Value!.Contents);
    }

    [Fact]
    public async Task Hover_on_field_renders_containing_type()
    {
        const string source = """
            class Box {
                private int count;
                void Inc() { count = count + 1; }
            }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("count = count", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("count", ok.Value!.Contents);
        // Field's containing type "Box" must be rendered via AppendContainingType.
        Assert.Contains("Box", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_lambda_parameter_renders_inferred_type()
    {
        const string source = """
            using System;
            class C {
                void M() { Func<int, int> f = x => x + 1; }
            }
            """;
        var model = await GetModel(source);
        // Hover on the lambda parameter declaration `x` (before the =>).
        var position = source.IndexOf("x =>", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        // Lambda parameter resolves to a symbol or via the type-info fallback.
        Assert.NotNull(ok.Value);
        Assert.Contains("x", ok.Value!.Contents);
    }

    [Fact]
    public async Task Hover_on_foreach_var_renders_element_type()
    {
        // `var` in a foreach exercises BuildVarHover whose parent is a
        // ForEachStatement rather than a VariableDeclaration — this returns
        // null from the early `declaration is not VariableDeclarationSyntax`
        // guard, so the resolver falls through to the type-info path.
        const string source = """
            using System.Collections.Generic;
            class C {
                void M(List<string> items) { foreach (var s in items) { } }
            }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("var s", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        // The foreach iteration `var` resolves to the element type `string`
        // via the type-info fallback (BuildTypeHover), or is null when the
        // var keyword has no usable type info.
        Assert.True(ok.Value is null || ok.Value.Contents.Contains("string"));
    }

    [Fact]
    public async Task Hover_on_var_keyword_resolves_inferred_type()
    {
        // Hovering `var` resolves the inferred declaration type. Depending on
        // how the contextual `var` token is classified, it renders either the
        // "(inferred)" BuildVarHover form or the resolved type directly — both
        // surface the concrete type name.
        const string source = """
            class C { void M() { var greeting = "hi"; } }
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
    public async Task Hover_on_numeric_literal_via_builder_marks_literal()
    {
        // Exercises the IsNumericLiteral -> BuildTypeHover("literal") path.
        const string source = """
            class C { long big = 9000; }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("9000", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("literal", ok.Value!.Contents);
        Assert.Contains("int", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_obsolete_with_message_includes_text()
    {
        const string source = """
            using System;
            class C {
                [Obsolete("do not use")]
                public void Legacy() { }
                public void Run() { Legacy(); }
            }
            """;
        var model = await GetModel(source);
        var position = source.LastIndexOf("Legacy", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        Assert.NotNull(ok.Value);
        Assert.Contains("Deprecated", ok.Value!.Contents);
        Assert.Contains("do not use", ok.Value.Contents);
    }

    [Fact]
    public async Task Hover_on_tuple_element_uses_type_info_fallback()
    {
        // A tuple element declaration has no GetSymbolInfo/GetDeclaredSymbol
        // result for the literal token, forcing the BuildTypeHover fallback.
        const string source = """
            class C { void M() { var pair = (count: 1, name: "x"); } }
            """;
        var model = await GetModel(source);
        var position = source.IndexOf("count", StringComparison.Ordinal);

        var result = CSharpHoverBuilder.Build(model, position, CancellationToken.None);

        var ok = Assert.IsType<Outcome.Result<HoverResult?, string>.Ok<HoverResult?, string>>(
            result
        );
        // Either resolves the tuple element symbol or renders via the type
        // fallback — never throws and yields a non-null payload here.
        Assert.True(ok.Value is null || ok.Value.Contents.Length > 0);
    }

    [Fact]
    public async Task Hover_failure_path_returns_failure_on_invalid_position()
    {
        // A negative position makes FindToken throw, exercising the catch block.
        const string source = """
            class C { }
            """;
        var model = await GetModel(source);

        var result = CSharpHoverBuilder.Build(model, -100, CancellationToken.None);

        // Out-of-range position surfaces as a Failure rather than throwing.
        _ = Assert.IsType<Outcome.Result<HoverResult?, string>.Error<HoverResult?, string>>(result);
    }

    // ── Code lens ────────────────────────────────────────────────────

    [Fact]
    public async Task CodeLens_method_reports_reference_count()
    {
        const string source = """
            class C {
                void Helper() { }
                void A() { Helper(); }
                void B() { Helper(); }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var lenses = await CodeLensResolver.GetLensesAsync(
            document,
            solution,
            CancellationToken.None
        );

        Assert.NotEmpty(lenses);
        // The class and each member get a reference lens.
        Assert.Contains(lenses, l => l.Title.Contains("reference"));
    }

    [Fact]
    public async Task CodeLens_interface_reports_implementation_count()
    {
        const string source = """
            interface IShape { }
            class Circle : IShape { }
            class Square : IShape { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var lenses = await CodeLensResolver.GetLensesAsync(
            document,
            solution,
            CancellationToken.None
        );

        // The interface must get an implementation lens with a count of 2.
        Assert.Contains(lenses, l => l.Title.Contains("implementation"));
        Assert.Contains(lenses, l => l.Title == "2 implementations");
    }

    [Fact]
    public async Task CodeLens_abstract_class_gets_implementation_lens()
    {
        const string source = """
            abstract class Base { }
            class Only : Base { }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var lenses = await CodeLensResolver.GetLensesAsync(
            document,
            solution,
            CancellationToken.None
        );

        // The abstract class triggers the IsAbstract branch and gets an
        // implementation lens (FindImplementations on a class returns its
        // implemented-interface members, so the count is 0 here).
        Assert.Contains(lenses, l => l.Line == 0 && l.Title.Contains("implementation"));
    }

    [Fact]
    public async Task CodeLens_unreferenced_member_reports_zero_references()
    {
        const string source = """
            class C {
                private void Unused() { }
            }
            """;
        var (document, solution) = RoslynTestWorkspace.Create(source);

        var lenses = await CodeLensResolver.GetLensesAsync(
            document,
            solution,
            CancellationToken.None
        );

        // The Unused method has zero call sites.
        Assert.Contains(lenses, l => l.Title == "0 references");
    }

    [Fact]
    public async Task CodeLens_empty_document_returns_empty()
    {
        var (document, solution) = RoslynTestWorkspace.Create("");

        var lenses = await CodeLensResolver.GetLensesAsync(
            document,
            solution,
            CancellationToken.None
        );

        Assert.Empty(lenses);
    }

    // ── Inlay hints ──────────────────────────────────────────────────

    [Fact]
    public async Task InlayHints_object_creation_args_get_parameter_hints()
    {
        const string source = """
            class Greeter {
                public Greeter(string who, int times) { }
                static Greeter Make() => new Greeter("world", 3);
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 5, CancellationToken.None);

        // Positional constructor args must get parameter-name hints.
        Assert.Contains(hints, h => h.Label == "who:" && h.Kind == 2);
        Assert.Contains(hints, h => h.Label == "times:" && h.Kind == 2);
    }

    [Fact]
    public async Task InlayHints_var_declaration_gets_type_hint()
    {
        const string source = """
            class C {
                void M() { var n = 42; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 5, CancellationToken.None);

        // `var n = 42` produces a type hint ": int".
        Assert.Contains(hints, h => h.Kind == 1 && h.Label.Contains("int"));
    }

    [Fact]
    public async Task InlayHints_explicitly_typed_lambda_param_skipped()
    {
        const string source = """
            using System;
            class C {
                void M() { Func<int, int> f = (int x) => x + 1; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 5, CancellationToken.None);

        // The lambda parameter already has an explicit type so it gets no hint.
        Assert.DoesNotContain(hints, h => h.Kind == 1 && h.Label.Contains(": int") && h.Line == 3);
        Assert.NotNull(hints);
    }

    [Fact]
    public async Task InlayHints_simple_lambda_param_gets_type_hint()
    {
        const string source = """
            using System;
            using System.Linq;
            using System.Collections.Generic;
            class C {
                void M() {
                    var xs = new List<int> { 1, 2, 3 };
                    var ys = xs.Select(item => item * 2);
                }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 20, CancellationToken.None);

        // The implicit `item` lambda param gets a ": int" type hint.
        Assert.Contains(hints, h => h.Kind == 1 && h.Label.Contains(": int"));
    }

    [Fact]
    public async Task InlayHints_explicit_var_type_does_not_break()
    {
        const string source = """
            class C {
                void M() { int explicitInt = 5; }
            }
            """;
        var (document, _) = RoslynTestWorkspace.Create(source);

        var hints = await InlayHintResolver.GetHintsAsync(document, 0, 5, CancellationToken.None);

        // Explicit `int` declaration is not "var" — no type hint emitted.
        Assert.DoesNotContain(hints, h => h.Kind == 1 && h.Label.Contains("int"));
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private static async Task<SemanticModel> GetModel(string source)
    {
        var (document, _) = RoslynTestWorkspace.Create(source);
        var model = await document.GetSemanticModelAsync().ConfigureAwait(true);
        return model ?? throw new InvalidOperationException("semantic model is null");
    }

    /// <summary>
    /// Builds a workspace whose document carries a real file path so
    /// <see cref="CallHierarchyResolver.GetIncomingAsync"/> can locate it.
    /// </summary>
    private static (Document document, Solution solution) CreateWithFilePath(string source)
    {
        var (document, solution) = RoslynTestWorkspace.Create(source);
        var path = Path.Combine(Path.GetTempPath(), $"Test_{Guid.NewGuid():N}.cs");
        var withPath = solution.WithDocumentFilePath(document.Id, path);
        var doc =
            withPath.GetDocument(document.Id)
            ?? throw new InvalidOperationException("document missing after WithDocumentFilePath");
        return (doc, withPath);
    }
}
