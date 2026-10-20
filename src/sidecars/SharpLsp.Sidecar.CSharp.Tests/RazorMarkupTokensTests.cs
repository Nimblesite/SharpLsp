using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Semantic tokens for Blazor markup, against the real fixture solution: component tags are
/// classes, component attributes properties, directive attributes decorators and directives
/// keywords, beside the C# fragments' own tokens and never overlapping them. Implements
/// [RAZOR-TESTING] for [RAZOR-FEATURES-SEMANTIC-TOKENS].
/// </summary>
public sealed class RazorMarkupTokensTests : IClassFixture<RazorFixture>
{
    private static readonly int Class = Legend("class");
    private static readonly int Property = Legend("property");
    private static readonly int Decorator = Legend("decorator");
    private static readonly int Keyword = Legend("keyword");

    private readonly RazorFixture _fixture;

    public RazorMarkupTokensTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Markup_names_the_compiler_binds_carry_their_token_types()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var tokens = Decode(RazorFixture.Ok(await manager.GetSemanticTokensFullAsync(Board)).Data);

        // Component tags, start and end, are classes; their parameters are properties.
        Assert.Contains((At("<Panel Title", "Panel"), 5, Class), tokens);
        Assert.Contains((At("</Panel>", "Panel"), 5, Class), tokens);
        Assert.Contains((At("<Badge Text", "Badge"), 5, Class), tokens);
        Assert.Contains((At("<Panel Title", "Title"), 5, Property), tokens);

        // Directive attributes are decorators: `@bind-` stops where its C# `Label` starts.
        Assert.Contains((At("<button @onclick", "@onclick"), 8, Decorator), tokens);
        Assert.Contains((At("@bind-Label", "@bind-"), 6, Decorator), tokens);

        // Directives are keywords; HTML carries no token at all.
        Assert.Contains((At("@page", "page"), 4, Keyword), tokens);
        Assert.Contains((At("@code", "code"), 4, Keyword), tokens);
        Assert.DoesNotContain(tokens, token => token.At == At("<button @onclick", "button"));

        // No token overlaps the one before it.
        Assert.All(
            tokens.Zip(tokens.Skip(1)),
            pair =>
                Assert.True(
                    pair.Second.At.Line > pair.First.At.Line
                        || pair.Second.At.Character >= pair.First.At.Character + pair.First.Length,
                    $"{pair.First} overlaps {pair.Second}"
                )
        );
    }

    private (int Line, int Character) At(string anchor, string token)
    {
        return RazorFixture.Locate(Board, anchor, token);
    }

    private static int Legend(string type)
    {
        return Array.IndexOf(SemanticTokensResolver.GetTokenTypes(), type);
    }

    /// <summary>LSP semantic token data as absolute (position, length, type) triples.</summary>
    private static List<((int Line, int Character) At, int Length, int Type)> Decode(int[] data)
    {
        var tokens = new List<((int, int), int, int)>();
        var (line, character) = (0, 0);
        for (var i = 0; i + 4 < data.Length; i += 5)
        {
            line += data[i];
            character = data[i] == 0 ? character + data[i + 1] : data[i + 1];
            tokens.Add(((line, character), data[i + 2], data[i + 3]));
        }

        return tokens;
    }
}
