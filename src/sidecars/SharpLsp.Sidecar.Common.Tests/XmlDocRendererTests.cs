using SharpLsp.Sidecar.Common.Hover;

namespace SharpLsp.Sidecar.Common.Tests;

public sealed class XmlDocRendererTests
{
    [Fact]
    public void Render_null_returns_empty()
    {
        Assert.Equal("", XmlDocRenderer.Render(null));
    }

    [Fact]
    public void Render_empty_string_returns_empty()
    {
        Assert.Equal("", XmlDocRenderer.Render(""));
    }

    [Fact]
    public void Render_invalid_xml_returns_empty()
    {
        Assert.Equal("", XmlDocRenderer.Render("<not closed"));
    }

    [Fact]
    public void Render_summary_produces_text()
    {
        const string xml = "<doc><summary>Adds two numbers.</summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("Adds two numbers.", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_params_produces_parameters_section()
    {
        const string xml = """
            <doc>
                <summary>Add.</summary>
                <param name="a">First number</param>
                <param name="b">Second number</param>
            </doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("**Parameters:**", result, StringComparison.Ordinal);
        Assert.Contains("`a`", result, StringComparison.Ordinal);
        Assert.Contains("`b`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_returns_produces_returns_section()
    {
        const string xml = "<doc><returns>The sum.</returns></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("**Returns:** The sum.", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_remarks_produces_italic()
    {
        const string xml = "<doc><remarks>Thread-safe.</remarks></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("*Thread-safe.*", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_exception_produces_exception_section()
    {
        const string xml = """
            <doc>
                <exception cref="T:System.ArgumentNullException">When null.</exception>
            </doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("**Exceptions:**", result, StringComparison.Ordinal);
        Assert.Contains("`ArgumentNullException`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_example_with_code_produces_code_block()
    {
        const string xml = """
            <doc>
                <example><code>var x = 1;</code></example>
            </doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("```csharp", result, StringComparison.Ordinal);
        Assert.Contains("var x = 1;", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_see_cref_produces_inline_code()
    {
        const string xml = """
            <doc><summary>See <see cref="T:System.String"/>.</summary></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`String`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_typeparam_produces_list()
    {
        const string xml = """
            <doc><typeparam name="T">The element type.</typeparam></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`T`", result, StringComparison.Ordinal);
        Assert.Contains("The element type.", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_paramref_produces_inline_code()
    {
        const string xml = """
            <doc><summary>Uses <paramref name="x"/>.</summary></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`x`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_inline_c_element_produces_inline_code()
    {
        const string xml = "<doc><summary>Call <c>Dispose</c> when done.</summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`Dispose`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_inline_code_element_produces_code_block()
    {
        const string xml = "<doc><summary>Like <code>var x = 1;</code></summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("```csharp", result, StringComparison.Ordinal);
        Assert.Contains("var x = 1;", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_para_element_breaks_paragraphs()
    {
        const string xml = "<doc><summary>First.<para/>Second.</summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("First.", result, StringComparison.Ordinal);
        Assert.Contains("Second.", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_unknown_inline_element_falls_back_to_its_text()
    {
        const string xml = "<doc><summary>Hello <bogus>world</bogus>.</summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("world", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_see_without_cref_renders_placeholder()
    {
        const string xml = "<doc><summary>See <see/> for details.</summary></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`?`", result, StringComparison.Ordinal);
    }

    [Fact]
    public void Render_example_without_code_renders_inline_text()
    {
        const string xml = "<doc><example>Just prose, no code.</example></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("Just prose, no code.", result, StringComparison.Ordinal);
    }
}
