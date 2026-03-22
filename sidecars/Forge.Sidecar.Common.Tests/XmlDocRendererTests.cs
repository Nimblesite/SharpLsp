using Forge.Sidecar.Common.Hover;

namespace Forge.Sidecar.Common.Tests;

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
        Assert.Contains("Adds two numbers.", result);
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
        Assert.Contains("**Parameters:**", result);
        Assert.Contains("`a`", result);
        Assert.Contains("`b`", result);
    }

    [Fact]
    public void Render_returns_produces_returns_section()
    {
        const string xml = "<doc><returns>The sum.</returns></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("**Returns:** The sum.", result);
    }

    [Fact]
    public void Render_remarks_produces_italic()
    {
        const string xml = "<doc><remarks>Thread-safe.</remarks></doc>";
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("*Thread-safe.*", result);
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
        Assert.Contains("**Exceptions:**", result);
        Assert.Contains("`ArgumentNullException`", result);
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
        Assert.Contains("```csharp", result);
        Assert.Contains("var x = 1;", result);
    }

    [Fact]
    public void Render_see_cref_produces_inline_code()
    {
        const string xml = """
            <doc><summary>See <see cref="T:System.String"/>.</summary></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`String`", result);
    }

    [Fact]
    public void Render_typeparam_produces_list()
    {
        const string xml = """
            <doc><typeparam name="T">The element type.</typeparam></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`T`", result);
        Assert.Contains("The element type.", result);
    }

    [Fact]
    public void Render_paramref_produces_inline_code()
    {
        const string xml = """
            <doc><summary>Uses <paramref name="x"/>.</summary></doc>
            """;
        var result = XmlDocRenderer.Render(xml);
        Assert.Contains("`x`", result);
    }
}
