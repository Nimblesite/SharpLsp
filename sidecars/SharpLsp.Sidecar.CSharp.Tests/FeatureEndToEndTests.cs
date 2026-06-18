using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E tests for new sidecar features: code actions, code lens,
/// completion resolve, semantic tokens, inlay hints, call/type hierarchy, formatting.
/// </summary>
public sealed class FeatureEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task CompletionResolve_returns_result()
    {
        var r = await fixture.SendAsync("textDocument/completion", fixture.PosPayload(32, 25));
        var items = MessagePackSerializer.Deserialize<CompletionItem[]>(r.Payload);
        Assert.NotEmpty(items);
        var resolvePayload = MessagePackSerializer.Serialize(
            new CompletionResolveRequest { FilePath = fixture.SourceFile, Index = items[0].Index }
        );
        await fixture.SendAndAssertOkAsync("completionItem/resolve", resolvePayload);
    }

    [Fact]
    public async Task CodeAction_returns_actions()
    {
        var payload = MessagePackSerializer.Serialize(
            new CodeActionRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 9,
                StartCharacter = 15,
                EndLine = 9,
                EndCharacter = 18,
            }
        );
        await fixture.SendAndAssertOkAsync("textDocument/codeAction", payload);
    }

    [Fact]
    public async Task CodeLens_returns_lenses_for_class()
    {
        var lenses = await fixture.SendAndDeserializeAsync<CodeLensResult[]>(
            "textDocument/codeLens",
            fixture.PosPayload(3, 0)
        );
        Assert.NotNull(lenses);
        Assert.NotEmpty(lenses);
        Assert.False(string.IsNullOrEmpty(lenses[0].Title));
    }

    [Fact]
    public async Task SemanticTokensFull_returns_token_data()
    {
        var tokens = await fixture.SendAndDeserializeAsync<SemanticTokensResult>(
            "textDocument/semanticTokens/full",
            fixture.PosPayload(0, 0)
        );
        Assert.NotEmpty(tokens.Data);
    }

    [Fact]
    public async Task SemanticTokensRange_returns_token_data()
    {
        var payload = MessagePackSerializer.Serialize(
            new RangeFormattingRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 0,
                StartCharacter = 0,
                EndLine = 15,
                EndCharacter = 0,
            }
        );
        var tokens = await fixture.SendAndDeserializeAsync<SemanticTokensResult>(
            "textDocument/semanticTokens/range",
            payload
        );
        Assert.NotEmpty(tokens.Data);
    }

    [Fact]
    public async Task InlayHint_returns_type_and_parameter_hints()
    {
        var payload = MessagePackSerializer.Serialize(
            new InlayHintRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 0,
                EndLine = 35,
            }
        );
        var hints = await fixture.SendAndDeserializeAsync<InlayHintResult[]>(
            "textDocument/inlayHint",
            payload
        );
        Assert.NotEmpty(hints);
        Assert.False(string.IsNullOrEmpty(hints[0].Label));
    }

    [Fact]
    public async Task PrepareCallHierarchy_on_method_returns_item()
    {
        var item = await fixture.SendAndDeserializeAsync<CallHierarchyItem>(
            "textDocument/prepareCallHierarchy",
            fixture.PosPayload(9, 15)
        );
        Assert.Contains("Add", item.Name);
    }

    [Fact]
    public async Task IncomingCalls_on_Add_finds_caller()
    {
        var calls = await fixture.SendAndDeserializeAsync<CallHierarchyCallResult[]>(
            "callHierarchy/incomingCalls",
            fixture.PosPayload(9, 15)
        );
        Assert.NotEmpty(calls);
    }

    [Fact]
    public async Task OutgoingCalls_returns_results()
    {
        var calls = await fixture.SendAndDeserializeAsync<CallHierarchyCallResult[]>(
            "callHierarchy/outgoingCalls",
            fixture.PosPayload(28, 20)
        );
        Assert.NotNull(calls);
    }

    [Fact]
    public async Task PrepareTypeHierarchy_on_class_returns_item()
    {
        var item = await fixture.SendAndDeserializeAsync<TypeHierarchyItem>(
            "textDocument/prepareTypeHierarchy",
            fixture.PosPayload(3, 13)
        );
        Assert.Contains("Calculator", item.Name);
    }

    [Fact]
    public async Task Supertypes_of_SimpleGreeter_includes_IGreeter()
    {
        var items = await fixture.SendAndDeserializeAsync<TypeHierarchyItem[]>(
            "typeHierarchy/supertypes",
            fixture.PosPayload(22, 13)
        );
        Assert.NotEmpty(items);
        Assert.Contains(items, i => i.Name.Contains("IGreeter"));
    }

    [Fact]
    public async Task Subtypes_of_IGreeter_includes_SimpleGreeter()
    {
        var items = await fixture.SendAndDeserializeAsync<TypeHierarchyItem[]>(
            "typeHierarchy/subtypes",
            fixture.PosPayload(17, 17)
        );
        Assert.NotEmpty(items);
        Assert.Contains(items, i => i.Name.Contains("SimpleGreeter"));
    }

    [Fact]
    public async Task Formatting_returns_edits()
    {
        await fixture.SendAndAssertOkAsync("textDocument/formatting", fixture.PosPayload(0, 0));
    }

    [Fact]
    public async Task RangeFormatting_returns_edits()
    {
        var payload = MessagePackSerializer.Serialize(
            new RangeFormattingRequest
            {
                FilePath = fixture.SourceFile,
                StartLine = 3,
                StartCharacter = 0,
                EndLine = 12,
                EndCharacter = 0,
            }
        );
        await fixture.SendAndAssertOkAsync("textDocument/rangeFormatting", payload);
    }

    [Fact]
    public async Task OnTypeFormatting_returns_edits()
    {
        var payload = MessagePackSerializer.Serialize(
            new OnTypeFormattingRequest
            {
                FilePath = fixture.SourceFile,
                Line = 9,
                Character = 50,
            }
        );
        await fixture.SendAndAssertOkAsync("textDocument/onTypeFormatting", payload);
    }
}
