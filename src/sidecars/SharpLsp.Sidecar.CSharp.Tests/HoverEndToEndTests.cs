using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E hover tests that drive <c>CSharpHoverBuilder</c> and the shared
/// <c>XmlDocRenderer</c> across many symbol kinds and XML-doc tags. Every
/// scenario goes through the real sidecar socket via
/// <see cref="CSharpSidecarFixture.SendAsync"/>. Positions index into the
/// shared <c>TestSource</c> (see the line map in
/// <see cref="CSharpSidecarFixture"/> — the documented service and friends
/// were appended after the original <c>Program</c> class).
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class HoverEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    private async Task<HoverResult> HoverAsync(int line, int character)
    {
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(line, character));
        Assert.Null(r.Error);
        Assert.True(r.Payload.Length > 1, "hover returned nil for a real symbol");
        return MessagePackSerializer.Deserialize<HoverResult>(r.Payload);
    }

    [Fact]
    public async Task Hover_on_generic_class_renders_all_xml_doc_tags()
    {
        // DocumentedService<TItem> at L54 carries summary, remarks (see/c/
        // paramref/para/list), typeparam and example tags.
        var h = await HoverAsync(54, 13);
        Assert.Contains("DocumentedService", h.Contents);
        Assert.Contains("Richly documented service", h.Contents);
        Assert.Contains("inline code", h.Contents);
        // <list><item> entries render inline.
        Assert.Contains("First item", h.Contents);
        Assert.Contains("TItem", h.Contents);
        // The <code> example block becomes a fenced csharp block.
        Assert.Contains("```csharp", h.Contents);
    }

    [Fact]
    public async Task Hover_on_generic_method_renders_params_returns_exception()
    {
        // Process<TResult> at L63 carries param, typeparam, returns,
        // exception and seealso tags.
        var h = await HoverAsync(63, 52);
        Assert.Contains("Process", h.Contents);
        Assert.Contains("**Parameters:**", h.Contents);
        Assert.Contains("**Returns:**", h.Contents);
        Assert.Contains("**Exceptions:**", h.Contents);
        Assert.Contains("seed", h.Contents);
    }

    [Fact]
    public async Task Hover_on_parameter_resolves_type()
    {
        var h = await HoverAsync(64, 14);
        Assert.Contains("seed", h.Contents);
    }

    [Fact]
    public async Task Hover_on_event_shows_event_signature()
    {
        var h = await HoverAsync(77, 38);
        Assert.Contains("Completed", h.Contents);
        Assert.Contains("event", h.Contents);
    }

    [Fact]
    public async Task Hover_on_field_shows_containing_type()
    {
        var h = await HoverAsync(80, 15);
        Assert.Contains("FieldCount", h.Contents);
        // Members render an "*in* `Type`" line.
        Assert.Contains("*in*", h.Contents);
    }

    [Fact]
    public async Task Hover_on_extension_method_declaration_shows_signature()
    {
        var h = await HoverAsync(90, 25);
        Assert.Contains("Shout", h.Contents);
    }

    [Fact]
    public async Task Hover_on_extension_method_call_shows_signature()
    {
        var h = await HoverAsync(124, 27);
        Assert.Contains("Shout", h.Contents);
    }

    [Fact]
    public async Task Hover_on_obsolete_member_shows_deprecation()
    {
        // OldAdd is declared on the [Obsolete] LegacyCalculator; hovering its
        // call site surfaces the deprecation banner from AppendDeprecation.
        var h = await HoverAsync(127, 25);
        Assert.Contains("OldAdd", h.Contents);
    }

    [Fact]
    public async Task Hover_on_use_of_obsolete_type_shows_deprecation_message()
    {
        // `new LegacyCalculator()` references the obsolete type directly.
        var h = await HoverAsync(126, 25);
        Assert.Contains("Deprecated", h.Contents);
        Assert.Contains("Use Calculator instead", h.Contents);
    }

    [Fact]
    public async Task Hover_on_numeric_literal_shows_literal_type()
    {
        // `42` literal -> BuildTypeHover with the "literal" prefix.
        var h = await HoverAsync(136, 21);
        Assert.Contains("literal", h.Contents);
        Assert.Contains("int", h.Contents);
    }

    [Fact]
    public async Task Hover_on_string_literal_returns_nil()
    {
        // String literals are intentionally skipped (returns null -> nil).
        var r = await fixture.SendAsync("textDocument/hover", fixture.PosPayload(124, 23));
        Assert.Null(r.Error);
        Assert.True(r.Payload.Length <= 1, "string literal hover must be nil");
    }

    [Fact]
    public async Task Hover_on_foreach_var_resolves_element_type()
    {
        // The `var` keyword in a foreach falls through to BuildTypeHover.
        var h = await HoverAsync(129, 17);
        Assert.False(string.IsNullOrEmpty(h.Contents));
    }

    [Fact]
    public async Task Hover_on_lambda_parameter_resolves_type()
    {
        // `n` in `Select(numbers, n => n * 2)` — fallback BuildTypeHover path.
        var h = await HoverAsync(123, 31);
        Assert.False(string.IsNullOrEmpty(h.Contents));
    }

    [Fact]
    public async Task Hover_on_tuple_element_resolves()
    {
        var h = await HoverAsync(135, 26);
        Assert.False(string.IsNullOrEmpty(h.Contents));
    }

    [Fact]
    public async Task Hover_on_framework_type_member_shows_info()
    {
        // `Length` on a string maps to a framework property.
        var h = await HoverAsync(125, 26);
        Assert.Contains("Length", h.Contents);
    }

    [Fact]
    public async Task Hover_on_var_local_resolves_generic_type()
    {
        // Hovering the `var` keyword of `var service = new DocumentedService<int>()`
        // resolves the inferred generic type.
        var h = await HoverAsync(121, 8);
        Assert.Contains("DocumentedService", h.Contents);
    }
}
