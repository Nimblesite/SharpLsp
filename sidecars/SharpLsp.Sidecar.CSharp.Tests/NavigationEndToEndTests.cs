using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E navigation tests: metadata decompilation fallback (go-to-definition on
/// framework symbols), call/type hierarchy across the appended class
/// hierarchy, inlay hints, semantic tokens, and code lens. All requests flow
/// through the real sidecar socket. Positions index into the appended
/// <c>TestSource</c> constructs.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class NavigationEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task Definition_on_framework_method_decompiles_metadata()
    {
        // `System.Console.WriteLine(...)` at L128 c23 has no in-source
        // location, forcing DefinitionResolver.ResolveMetadataFallbackAsync
        // and MetadataNavigator to decompile Console.
        var r = await fixture.SendAsync("textDocument/definition", fixture.PosPayload(128, 23));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
        Assert.EndsWith(".cs", loc.Locations[0].FilePath);
        Assert.Contains("decompiled", loc.Locations[0].FilePath);
    }

    [Fact]
    public async Task TypeDefinition_on_framework_typed_local_decompiles_metadata()
    {
        // The `var` of `var len = "hello".Length;` (L125 c8) infers `int`
        // (System.Int32), which has no in-source location — type definition
        // falls back to decompiled metadata (ResolveMetadataFallbackSingleAsync).
        var r = await fixture.SendAsync("textDocument/typeDefinition", fixture.PosPayload(125, 8));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
        Assert.EndsWith(".cs", loc.Locations[0].FilePath);
    }

    [Fact]
    public async Task PrepareTypeHierarchy_on_abstract_class_returns_item()
    {
        var r = await fixture.SendAsync(
            "textDocument/prepareTypeHierarchy",
            fixture.PosPayload(100, 22)
        );
        Assert.Null(r.Error);
        var item = MessagePackSerializer.Deserialize<TypeHierarchyItem>(r.Payload);
        Assert.Equal("Shape", item.Name);
    }

    [Fact]
    public async Task Subtypes_of_abstract_Shape_includes_derived_classes()
    {
        var r = await fixture.SendAsync("typeHierarchy/subtypes", fixture.PosPayload(100, 22));
        Assert.Null(r.Error);
        var items = MessagePackSerializer.Deserialize<TypeHierarchyItem[]>(r.Payload);
        Assert.Contains(items, i => i.Name == "Circle");
        Assert.Contains(items, i => i.Name == "Square");
    }

    [Fact]
    public async Task Supertypes_of_Circle_includes_Shape()
    {
        var r = await fixture.SendAsync("typeHierarchy/supertypes", fixture.PosPayload(105, 13));
        Assert.Null(r.Error);
        var items = MessagePackSerializer.Deserialize<TypeHierarchyItem[]>(r.Payload);
        Assert.Contains(items, i => i.Name == "Shape");
    }

    [Fact]
    public async Task IncomingCalls_on_OldAdd_finds_consumer()
    {
        // OldAdd (declared L97) is called by Consumer.Use at L127.
        var r = await fixture.SendAsync("callHierarchy/incomingCalls", fixture.PosPayload(97, 15));
        Assert.Null(r.Error);
        var calls = MessagePackSerializer.Deserialize<CallHierarchyCallResult[]>(r.Payload);
        Assert.NotEmpty(calls);
    }

    [Fact]
    public async Task OutgoingCalls_from_Use_finds_invocations()
    {
        // Consumer.Use (declared L119) invokes Shout, OldAdd, WriteLine, etc.
        var r = await fixture.SendAsync("callHierarchy/outgoingCalls", fixture.PosPayload(119, 20));
        Assert.Null(r.Error);
        var calls = MessagePackSerializer.Deserialize<CallHierarchyCallResult[]>(r.Payload);
        Assert.NotEmpty(calls);
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_Use_returns_method_item()
    {
        var r = await fixture.SendAsync(
            "textDocument/prepareCallHierarchy",
            fixture.PosPayload(119, 20)
        );
        Assert.Null(r.Error);
        var item = MessagePackSerializer.Deserialize<CallHierarchyItem>(r.Payload);
        Assert.Equal("Use", item.Name);
        Assert.Equal("method", item.Kind);
    }

    [Fact]
    public async Task InlayHint_over_consumer_body_returns_type_and_param_hints()
    {
        // The Consumer.Use body (L119-139) is dense with var locals (type
        // hints), a lambda parameter, and method-call arguments (param hints).
        var payload = MessagePackSerializer.Serialize(
            new InlayHintRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 119,
                EndLine = 139,
            }
        );
        var r = await fixture.SendAsync("textDocument/inlayHint", payload);
        Assert.Null(r.Error);
        var hints = MessagePackSerializer.Deserialize<InlayHintResult[]>(r.Payload);
        Assert.NotEmpty(hints);
        Assert.Contains(hints, h => h.Kind == 1); // a type hint
    }

    [Fact]
    public async Task SemanticTokensFull_over_rich_source_returns_many_tokens()
    {
        var r = await fixture.SendAsync(
            "textDocument/semanticTokens/full",
            fixture.PosPayload(0, 0)
        );
        Assert.Null(r.Error);
        var tokens = MessagePackSerializer.Deserialize<SemanticTokensResult>(r.Payload);
        // Each token is 5 ints; the rich source yields well over 50 tokens.
        Assert.Equal(0, tokens.Data.Length % 5);
        Assert.True(tokens.Data.Length > 50);
    }

    [Fact]
    public async Task SemanticTokensRange_over_documented_service_returns_tokens()
    {
        var payload = MessagePackSerializer.Serialize(
            new RangeFormattingRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 54,
                StartCharacter = 0,
                EndLine = 84,
                EndCharacter = 0,
            }
        );
        var r = await fixture.SendAsync("textDocument/semanticTokens/range", payload);
        Assert.Null(r.Error);
        var tokens = MessagePackSerializer.Deserialize<SemanticTokensResult>(r.Payload);
        Assert.NotEmpty(tokens.Data);
    }

    [Fact]
    public async Task CodeLens_on_interface_includes_implementation_count()
    {
        // IGreeter (L17) is an interface, so CollectLensesAsync adds both a
        // reference lens and an implementation-count lens.
        var r = await fixture.SendAsync("textDocument/codeLens", fixture.PosPayload(17, 0));
        Assert.Null(r.Error);
        var lenses = MessagePackSerializer.Deserialize<CodeLensResult[]>(r.Payload);
        Assert.NotEmpty(lenses);
        Assert.Contains(lenses, l => l.Title.Contains("implementation"));
    }

    [Fact]
    public async Task CodeLens_on_abstract_class_includes_implementation_count()
    {
        var r = await fixture.SendAsync("textDocument/codeLens", fixture.PosPayload(100, 0));
        Assert.Null(r.Error);
        var lenses = MessagePackSerializer.Deserialize<CodeLensResult[]>(r.Payload);
        Assert.NotEmpty(lenses);
        Assert.Contains(lenses, l => l.Title.Contains("implementation"));
    }

    [Fact]
    public async Task Implementation_of_abstract_Area_finds_overrides()
    {
        // Area is abstract on Shape (declared L102 c27) and overridden by
        // Circle and Square — implementation resolves the override locations.
        var r = await fixture.SendAsync("textDocument/implementation", fixture.PosPayload(102, 27));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.NotEmpty(loc.Locations);
    }

    [Fact]
    public async Task References_to_Shape_finds_derived_usages()
    {
        var payload = MessagePackSerializer.Serialize(
            new ReferencesRequest
            {
                FilePath = fixture.SourceFile,
                Line = 100,
                Character = 22,
                IncludeDeclaration = true,
            }
        );
        var r = await fixture.SendAsync("textDocument/references", payload);
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        Assert.True(loc.Locations.Count > 1);
    }

    [Fact]
    public async Task DocumentHighlight_on_numbers_local_marks_read_and_write()
    {
        // `numbers` is declared and read multiple times in Use().
        var payload = MessagePackSerializer.Serialize(
            new PositionRequest
            {
                FilePath = fixture.SourceFile,
                Line = 122,
                Character = 12,
            }
        );
        var r = await fixture.SendAsync("textDocument/documentHighlight", payload);
        Assert.Null(r.Error);
        var result = MessagePackSerializer.Deserialize<DocumentHighlightListResult>(r.Payload);
        Assert.NotEmpty(result.Highlights);
    }

    [Fact]
    public async Task Completion_resolve_returns_additional_edits_shape()
    {
        var completionResp = await fixture.SendAsync(
            "textDocument/completion",
            fixture.PosPayload(128, 23)
        );
        Assert.Null(completionResp.Error);
        var items = MessagePackSerializer.Deserialize<CompletionItem[]>(completionResp.Payload);
        Assert.NotEmpty(items);

        var resolveResp = await fixture.SendAsync(
            "completionItem/resolve",
            MessagePackSerializer.Serialize(
                new CompletionResolveRequest
                {
                    FilePath = fixture.SourceFile,
                    Index = items[0].Index,
                }
            )
        );
        Assert.Null(resolveResp.Error);
        var resolved = MessagePackSerializer.Deserialize<CompletionResolveResult>(
            resolveResp.Payload
        );
        Assert.NotNull(resolved.AdditionalEdits);
    }
}
