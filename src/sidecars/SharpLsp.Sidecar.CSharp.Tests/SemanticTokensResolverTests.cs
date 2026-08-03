using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coverage for the semantic-token legend the host advertises in its server
/// capabilities. The encode/classify path is driven end to end through the
/// workspace; these assertions pin the static type and modifier legends so the
/// indices the encoder emits stay aligned with what the host registers.
/// </summary>
public sealed class SemanticTokensResolverTests
{
    [Fact]
    public void GetTokenTypes_lists_the_full_lsp_legend_in_index_order()
    {
        var types = SemanticTokensResolver.GetTokenTypes();

        Assert.Equal("namespace", types[0]);
        Assert.Equal("type", types[1]);
        Assert.Equal("class", types[2]);
        Assert.Equal("comment", types[17]);
        Assert.Equal("decorator", types[^1]);
        Assert.Equal(23, types.Length);
    }

    [Fact]
    public void GetTokenModifiers_lists_the_full_modifier_legend_in_index_order()
    {
        var modifiers = SemanticTokensResolver.GetTokenModifiers();

        Assert.Equal("declaration", modifiers[0]);
        Assert.Equal("definition", modifiers[1]);
        Assert.Equal("static", modifiers[3]);
        Assert.Equal("async", modifiers[^1]);
        Assert.Equal(7, modifiers.Length);
    }
}
