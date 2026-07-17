using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E coverage tests for <c>MetadataNavigator</c> driven through the real sidecar
/// socket. Two axes:
///
/// <para>
/// (1) The "no navigable location" guard — go-to-definition / declaration on a
/// metadata NAMESPACE (e.g. <c>System</c> in a <c>using</c> directive). A
/// compilation-level namespace spans assemblies, so its containing assembly is
/// <see langword="null"/>; <c>MetadataNavigator.ResolveMetadataSymbolCore</c> bails
/// at the assembly-path guard and the resolver returns an empty (non-error)
/// location list.
/// </para>
///
/// <para>
/// (2) The decompilation success path reached through DefinitionResolver's
/// type-definition and definition metadata fallbacks for framework type shapes
/// (class, generic class, delegate, value type) that the existing navigation suites
/// do not drive via those entry points.
/// </para>
///
/// All requests flow through socket → FramedTransport → MessageRouter →
/// CSharpSidecar → DefinitionResolver → MetadataNavigator.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class MetadataNavigatorCoverageEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private byte[] Pos(int line, int character)
    {
        return CSharpSidecarFixture.PosFor(fixture.MetaProbeFile, line, character);
    }

    // ── (1) Metadata namespace → no navigable location (assembly-path guard) ──

    [Theory]
    [InlineData(0, 6)] // `System` of `using System;`
    [InlineData(1, 6)] // `System` of `using System.Collections.Generic;`
    [InlineData(2, 6)] // `System` of `using System.Text;`
    [InlineData(1, 13)] // `Collections` → System.Collections
    [InlineData(1, 25)] // `Generic` → System.Collections.Generic
    [InlineData(2, 13)] // `Text` → System.Text
    public async Task Definition_on_metadata_namespace_yields_no_location(int line, int character)
    {
        // The resolved symbol is a compilation namespace whose ContainingAssembly is
        // null, so MetadataNavigator resolves no assembly path and returns null,
        // leaving the definition result an empty (but non-error) location list.
        var loc = await fixture.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/definition",
            Pos(line, character)
        );
        Assert.Empty(loc.Locations);
    }

    [Fact]
    public async Task Declaration_on_metadata_namespace_yields_no_location()
    {
        // Declaration routes through the SINGLE-location metadata fallback; the
        // namespace still has no assembly path, so the result is an empty list.
        var payload = MessagePackSerializer.Serialize(
            new PositionRequest
            {
                FilePath = fixture.MetaProbeFile,
                Line = 0,
                Character = 6,
            }
        );
        var loc = await fixture.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/declaration",
            payload
        );
        Assert.Empty(loc.Locations);
    }

    // ── (2) Decompilation success across framework type shapes ───────────────

    [Fact]
    public async Task TypeDefinition_on_generic_type_local_decompiles_metadata()
    {
        // `var list = new List<int>();` (L35) — the local's type is the constructed
        // generic System.Collections.Generic.List<int>. GetContainingType returns the
        // top-level List`1, which decompiles successfully.
        var loc = await fixture.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/typeDefinition",
            Pos(35, 8)
        );
        Assert.NotEmpty(loc.Locations);
        Assert.EndsWith(".cs", loc.Locations[0].FilePath);
    }

    [Fact]
    public async Task Definition_on_framework_delegate_type_decompiles_metadata()
    {
        // `Func<int, int> dbl = ...` (L45) — the `Func` reference resolves to the
        // metadata delegate System.Func<T, TResult>, decompiled via the definition
        // list metadata fallback.
        var loc = await fixture.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/definition",
            Pos(45, 9)
        );
        Assert.NotEmpty(loc.Locations);
        Assert.EndsWith(".cs", loc.Locations[0].FilePath);
    }

    [Fact]
    public async Task TypeDefinition_on_value_type_local_decompiles_metadata()
    {
        // `var total = list.Count + Limit;` (L38) — the local's type is System.Int32,
        // a metadata value type reached through the type-definition metadata fallback.
        var loc = await fixture.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/typeDefinition",
            Pos(38, 8)
        );
        Assert.NotEmpty(loc.Locations);
        Assert.EndsWith(".cs", loc.Locations[0].FilePath);
    }
}
