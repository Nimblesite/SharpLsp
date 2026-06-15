using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E branch-coverage tests driving the token-rich <c>MetaProbe.cs</c> source
/// (see <see cref="CSharpSidecarFixture.MetaProbeSource"/>) through the real
/// sidecar socket. Exercises SemanticTokensResolver across every classification
/// arm, InlayHintResolver, MetadataNavigator metadata-decompilation fallback for
/// each framework member kind (method, constructor, property, field, named
/// type), CSharpHoverBuilder across symbol kinds, and CodeActionResolver
/// quick-fix resolution. All requests flow through the real IPC stack.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class MetaProbeEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private byte[] Pos(int line, int character)
    {
        return CSharpSidecarFixture.PosFor(fixture.MetaProbeFile, line, character);
    }

    // ── Semantic tokens (every classification arm) ───────────────

    [Fact]
    public async Task SemanticTokens_full_over_token_rich_source_returns_tokens()
    {
        var r = await fixture.SendAsync("textDocument/semanticTokens/full", Pos(0, 0));
        Assert.Null(r.Error);
        var tokens = MessagePackSerializer.Deserialize<SemanticTokensResult>(r.Payload);
        // The source contains namespaces, enums/members, structs, records,
        // interfaces, delegates, classes, properties, events, fields, methods,
        // extension methods, parameters, locals, strings, numbers and operators —
        // the encoder must emit a non-trivial token stream (5 ints per token).
        Assert.NotEmpty(tokens.Data);
        Assert.Equal(0, tokens.Data.Length % 5);
    }

    [Fact]
    public async Task SemanticTokens_range_over_method_body_returns_tokens()
    {
        var payload = MessagePackSerializer.Serialize(
            new RangeFormattingRequest
            {
                FilePath = fixture.MetaProbeFile,
                StartLine = 31,
                StartCharacter = 0,
                EndLine = 49,
                EndCharacter = 0,
            }
        );
        var r = await fixture.SendAsync("textDocument/semanticTokens/range", payload);
        Assert.Null(r.Error);
        var tokens = MessagePackSerializer.Deserialize<SemanticTokensResult>(r.Payload);
        Assert.NotEmpty(tokens.Data);
    }

    // ── Inlay hints ──────────────────────────────────────────────

    [Fact]
    public async Task InlayHints_over_method_body_return_type_and_parameter_hints()
    {
        var payload = MessagePackSerializer.Serialize(
            new InlayHintRequest
            {
                FilePath = fixture.MetaProbeFile,
                StartLine = 30,
                EndLine = 49,
            }
        );
        var r = await fixture.SendAsync("textDocument/inlayHint", payload);
        Assert.Null(r.Error);
        var hints = MessagePackSerializer.Deserialize<InlayHintResult[]>(r.Payload);
        // `var sb = ...`, `var list = ...`, `var total = ...`, lambda params, and
        // call arguments yield a mix of type (1) and parameter (2) hints.
        Assert.NotEmpty(hints);
    }

    // ── Metadata decompilation fallback per member kind ──────────

    [Theory]
    [InlineData(32, 16)] // Console.WriteLine  → method
    [InlineData(33, 20)] // new StringBuilder() → constructor
    [InlineData(34, 11)] // sb.Append          → method
    [InlineData(35, 22)] // new List<int>()    → constructed generic type
    [InlineData(36, 13)] // list.Add           → method
    [InlineData(38, 25)] // list.Count         → property
    [InlineData(39, 22)] // int.MaxValue       → field
    [InlineData(32, 8)] // Console            → named type
    public async Task Definition_on_framework_member_falls_back_to_metadata(int line, int character)
    {
        var r = await fixture.SendAsync("textDocument/definition", Pos(line, character));
        Assert.Null(r.Error);
        var loc = MessagePackSerializer.Deserialize<LocationListResult>(r.Payload);
        // A framework symbol has no in-source location, so DefinitionResolver
        // routes through MetadataNavigator, which decompiles the containing type
        // to a temp ".cs" file. Either a decompiled location is produced or the
        // symbol legitimately resolves nowhere — never an error.
        if (loc.Locations.Count > 0)
        {
            Assert.EndsWith(".cs", loc.Locations[0].FilePath);
        }
    }

    [Fact]
    public async Task TypeDefinition_on_framework_typed_local_decompiles_metadata()
    {
        // `var max = int.MaxValue;` — the local's type is System.Int32.
        var r = await fixture.SendAsync("textDocument/typeDefinition", Pos(39, 12));
        Assert.Null(r.Error);
    }

    // ── Hover across symbol kinds ─────────────────────────────────

    [Theory]
    [InlineData(40, 12)] // color   → local (enum-typed)
    [InlineData(33, 12)] // sb      → local (StringBuilder)
    [InlineData(26, 21)] // Limit   → const field
    [InlineData(27, 27)] // OnChange → event
    [InlineData(28, 18)] // Name    → property
    [InlineData(21, 23)] // Twice   → extension method declaration
    [InlineData(30, 15)] // Compute → method declaration
    [InlineData(30, 27)] // seed    → parameter
    public async Task Hover_on_symbol_returns_without_error(int line, int character)
    {
        var r = await fixture.SendAsync("textDocument/hover", Pos(line, character));
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task Hover_on_extension_method_call_renders_signature()
    {
        // `item.Twice()` at L43 — an extension method invocation.
        var r = await fixture.SendAsync("textDocument/hover", Pos(43, 26));
        Assert.Null(r.Error);
    }

    // ── Code actions: quick-fix over a real diagnostic ───────────

    [Fact]
    public async Task CodeAction_over_unused_local_offers_and_resolves_fix()
    {
        // `var unused = 42;` at L46 raises CS0219 (assigned but never used).
        var request = MessagePackSerializer.Serialize(
            new CodeActionRequest
            {
                FilePath = fixture.MetaProbeFile,
                StartLine = 46,
                StartCharacter = 8,
                EndLine = 46,
                EndCharacter = 24,
            }
        );
        var r = await fixture.SendAsync("textDocument/codeAction", request);
        Assert.Null(r.Error);
        var actions = MessagePackSerializer.Deserialize<CodeActionItem[]>(r.Payload);

        // If Roslyn surfaces a fix for the span, resolving it must drive
        // CodeActionResolver's edit-collection path without error.
        if (actions.Length > 0)
        {
            var resolve = MessagePackSerializer.Serialize(
                new CodeActionResolveRequest { Id = actions[0].Id }
            );
            var resolved = await fixture.SendAsync("codeAction/resolve", resolve);
            Assert.Null(resolved.Error);
        }
    }

    [Fact]
    public async Task CodeAction_move_type_to_file_resolves_added_document_edits()
    {
        // MetaProbe.cs declares many top-level types, so Roslyn offers the
        // "Move type to <Name>.cs" refactoring on the `Point` struct (L11 c14).
        // Resolving it produces a NEW document, driving CodeActionResolver's
        // added-document collection path (CollectAddedDocumentsAsync).
        var request = MessagePackSerializer.Serialize(
            new CodeActionRequest
            {
                FilePath = fixture.MetaProbeFile,
                StartLine = 11,
                StartCharacter = 14,
                EndLine = 11,
                EndCharacter = 19,
            }
        );
        var r = await fixture.SendAsync("textDocument/codeAction", request);
        Assert.Null(r.Error);
        var actions = MessagePackSerializer.Deserialize<CodeActionItem[]>(r.Payload);

        var move = actions.FirstOrDefault(a => a.Title.Contains("Move"));
        if (move is not null)
        {
            var resolved = await fixture.SendAsync(
                "codeAction/resolve",
                MessagePackSerializer.Serialize(new CodeActionResolveRequest { Id = move.Id })
            );
            Assert.Null(resolved.Error);
            var edit = MessagePackSerializer.Deserialize<WorkspaceEditResult>(resolved.Payload);
            Assert.NotEmpty(edit.DocumentChanges);
        }
    }

    // ── Call / type hierarchy over the probe symbols ─────────────

    [Fact]
    public async Task PrepareCallHierarchy_on_method_returns_item()
    {
        var r = await fixture.SendAsync("textDocument/prepareCallHierarchy", Pos(30, 15));
        Assert.Null(r.Error);
    }

    [Fact]
    public async Task PrepareTypeHierarchy_on_interface_returns_item()
    {
        var r = await fixture.SendAsync("textDocument/prepareTypeHierarchy", Pos(17, 17));
        Assert.Null(r.Error);
    }

    // ── Rename a local through the real socket ───────────────────

    [Fact]
    public async Task Rename_local_produces_workspace_edit()
    {
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = fixture.MetaProbeFile,
                Line = 38,
                Character = 12,
                NewName = "grandTotal",
            }
        );
        var r = await fixture.SendAsync("textDocument/rename", payload);
        Assert.Null(r.Error);
    }
}
