using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E hover tests that drive the harder-to-reach branches of
/// <c>CSharpHoverBuilder</c> through the real sidecar socket: the
/// <c>ResolveSymbol</c> <c>GetTypeInfo</c> fallback, the <c>BuildTypeHover</c>
/// null-type guard, and the inferred-type resolution behind a <c>var</c>
/// declaration. Positions index into the shared <c>TestSource</c> (see the line
/// map in <see cref="CSharpSidecarFixture"/>).
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class HoverBuilderCoverageEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    // The '=' of an initializer parents onto an EqualsValueClause, which has no
    // declared symbol, no symbol-info and no type. ResolveSymbol therefore runs
    // GetDeclaredSymbol (null), GetSymbolInfo (none), then falls through to the
    // GetTypeInfo branch whose Type is null and returns null. ResolveAndBuild then
    // reaches the BuildTypeHover fallback, whose own GetTypeInfo yields a null
    // type, so hover collapses to nil.
    [Fact]
    public async Task Hover_on_initializer_equals_token_returns_nil()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(136, 19));
        Assert.Null(r.Error);
        Assert.True(r.Payload.Length <= 1, "an '=' initializer token has no symbol or type");
        Assert.Null(MessagePackSerializer.Deserialize<HoverResult>(r.Payload));
    }

    // A method-body block's open brace parents onto a BlockSyntax, which is also
    // symbol-less and type-less. It exercises the same GetTypeInfo fallback and
    // BuildTypeHover null-type guard via a different node kind.
    [Fact]
    public async Task Hover_on_method_body_open_brace_returns_nil()
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(120, 4));
        Assert.Null(r.Error);
        Assert.True(r.Payload.Length <= 1, "a block '{' token has no symbol or type");
        Assert.Null(MessagePackSerializer.Deserialize<HoverResult>(r.Payload));
    }

    // A tuple literal carries no symbol, so ResolveSymbol falls through to its
    // GetTypeInfo branch, which resolves the anonymous tuple type and drives
    // BuildFromSymbol to non-nil content.
    [Fact]
    public async Task Hover_on_tuple_literal_resolves_tuple_type()
    {
        var h = await fixture.SendAndDeserializeAsync<HoverResult>(
            "textDocument/hover",
            fixture.PosPayload(134, 20)
        );
        Assert.Contains("int", h.Contents);
        Assert.Contains("string", h.Contents);
        Assert.NotNull(h.StartLine);
    }

    // Hovering the 'var' keyword of a concrete-typed local. When 'var' surfaces as
    // a VarKeyword token this drives BuildVarHover's inferred-signature path;
    // otherwise the inferred type is resolved through ResolveSymbol. Either way the
    // concrete type name must appear in the hover.
    [Fact]
    public async Task Hover_on_var_keyword_of_named_local_resolves_type()
    {
        var h = await fixture.SendAndDeserializeAsync<HoverResult>(
            "textDocument/hover",
            fixture.PosPayload(126, 8)
        );
        Assert.Contains("LegacyCalculator", h.Contents);
        Assert.NotNull(h.StartLine);
    }

    // Hovering the 'var' keyword of a generic-typed local, exercising the same
    // inferred-type resolution against a constructed generic type.
    [Fact]
    public async Task Hover_on_var_keyword_of_generic_local_resolves_type()
    {
        var h = await fixture.SendAndDeserializeAsync<HoverResult>(
            "textDocument/hover",
            fixture.PosPayload(123, 8)
        );
        Assert.Contains("IEnumerable", h.Contents);
        Assert.NotNull(h.StartLine);
    }
}
