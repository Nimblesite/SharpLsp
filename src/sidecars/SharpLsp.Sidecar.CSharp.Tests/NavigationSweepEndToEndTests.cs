using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E breadth sweep: drives hover, definition, document highlight and
/// references across a wide spread of MetaProbe symbol kinds (locals,
/// parameters, fields, consts, events, properties, methods, extension methods,
/// enum members, records, structs, interfaces, delegates) through the real
/// sidecar socket. Each request exercises a different branch of HoverBuilder,
/// DefinitionResolver, and the highlight/reference resolvers.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class NavigationSweepEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private byte[] Pos(int line, int character)
    {
        return CSharpSidecarFixture.PosFor(fixture.MetaProbeFile, line, character);
    }

    // A spread of identifier positions across every symbol kind in MetaProbe.cs.
    public static TheoryData<int, int> Symbols =>
        new()
        {
            { 7, 12 }, // Color enum type
            { 7, 20 }, // Red enum member
            { 9, 20 }, // Transform delegate
            { 11, 14 }, // Point struct
            { 11, 30 }, // X field
            { 13, 30 }, // Pair record struct
            { 15, 14 }, // Money record
            { 17, 17 }, // IShape interface
            { 17, 30 }, // Area interface method
            { 21, 23 }, // Twice extension method
            { 24, 19 }, // Probe class
            { 26, 21 }, // Limit const
            { 27, 27 }, // OnChange event
            { 28, 18 }, // Name property
            { 30, 15 }, // Compute method
            { 30, 27 }, // seed parameter
            { 33, 12 }, // sb local
            { 35, 12 }, // list local
            { 40, 12 }, // color local
            { 41, 17 }, // item foreach var
            { 45, 20 }, // dbl lambda local
            { 55, 15 }, // Doc method
        };

    [Theory]
    [MemberData(nameof(Symbols))]
    public async Task Hover_across_symbol_kinds_returns_without_error(int line, int character)
    {
        await fixture.SendAndAssertOkAsync("textDocument/hover", Pos(line, character));
    }

    [Theory]
    [MemberData(nameof(Symbols))]
    public async Task Definition_across_symbol_kinds_returns_without_error(int line, int character)
    {
        await fixture.SendAndAssertOkAsync("textDocument/definition", Pos(line, character));
    }

    [Theory]
    [MemberData(nameof(Symbols))]
    public async Task DocumentHighlight_across_symbol_kinds_returns_without_error(
        int line,
        int character
    )
    {
        await fixture.SendAndAssertOkAsync("textDocument/documentHighlight", Pos(line, character));
    }

    [Theory]
    [InlineData(26, 21)] // Limit const — referenced in Compute
    [InlineData(27, 27)] // OnChange event — referenced in Compute
    [InlineData(30, 15)] // Compute method
    [InlineData(21, 23)] // Twice extension method — referenced via item.Twice()
    public async Task References_across_members_return_without_error(int line, int character)
    {
        var payload = MessagePackSerializer.Serialize(
            new ReferencesRequest
            {
                FilePath = fixture.MetaProbeFile,
                Line = line,
                Character = character,
                IncludeDeclaration = true,
            }
        );
        await fixture.SendAndAssertOkAsync("textDocument/references", payload);
    }
}
