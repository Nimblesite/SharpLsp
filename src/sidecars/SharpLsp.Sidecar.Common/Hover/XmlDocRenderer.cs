using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace SharpLsp.Sidecar.Common.Hover;

/// <summary>
/// Renders XML documentation comments into Markdown.
/// Shared between C# and F# sidecars.
/// </summary>
public static partial class XmlDocRenderer
{
    /// <summary>Render a Roslyn/FCS XML doc string to Markdown.</summary>
    public static string Render(string? xmlDoc)
    {
        if (string.IsNullOrWhiteSpace(xmlDoc))
        {
            return "";
        }

        try
        {
            var doc = XDocument.Parse(xmlDoc);
            var root = doc.Root;
            return root is null ? "" : RenderRoot(root);
        }
        catch (System.Xml.XmlException)
        {
            return "";
        }
    }

    private static string RenderRoot(XElement root)
    {
        var sb = new StringBuilder();
        AppendText(sb, root.Element("summary"), text => text, separated: false);
        AppendList(sb, root, "typeparam", null, tp => NamedItem(tp, "T"));
        AppendList(sb, root, "param", "**Parameters:**", param => NamedItem(param, "?"));
        AppendText(sb, root.Element("returns"), text => $"**Returns:** {text}", separated: true);
        AppendText(sb, root.Element("remarks"), text => $"*{text}*", separated: true);
        AppendList(sb, root, "exception", "**Exceptions:**", ExceptionItem);
        AppendList(sb, root, "example", null, ExampleText);
        return sb.ToString().TrimEnd();
    }

    /// <summary>
    /// One single-element section (summary, returns, remarks), formatted when it has text and
    /// preceded by a blank line when <paramref name="separated"/>.
    /// </summary>
    private static void AppendText(
        StringBuilder sb,
        XElement? element,
        Func<string, string> format,
        bool separated
    )
    {
        var text = element is null ? "" : InlineContent(element).Trim();
        if (text.Length == 0)
        {
            return;
        }

        _ = separated ? sb.AppendLine() : sb;
        _ = sb.AppendLine(format(text));
    }

    /// <summary>
    /// One repeated-element section (type parameters, parameters, exceptions, examples): a blank
    /// line, the optional header, then one line per element.
    /// </summary>
    private static void AppendList(
        StringBuilder sb,
        XElement root,
        string elementName,
        string? header,
        Func<XElement, string> item
    )
    {
        var elements = root.Elements(elementName).ToList();
        if (elements.Count == 0)
        {
            return;
        }

        _ = sb.AppendLine();
        _ = header is null ? sb : sb.AppendLine(header);
        elements.ForEach(element => sb.AppendLine(item(element)));
    }

    /// <summary>A <c>name</c>-attributed element as <c>- `name`: description</c>.</summary>
    private static string NamedItem(XElement element, string fallbackName)
    {
        var name = element.Attribute("name")?.Value ?? fallbackName;
        return $"- `{name}`: {InlineContent(element).Trim()}";
    }

    private static string ExceptionItem(XElement exception)
    {
        var cref = CrefToDisplay(exception.Attribute("cref")?.Value);
        return $"- `{cref}` \u2014 {InlineContent(exception).Trim()}";
    }

    /// <summary>An example's <c>code</c> as a fenced block, otherwise its inline text.</summary>
    private static string ExampleText(XElement example)
    {
        var code = example.Element("code");
        return code is null
            ? InlineContent(example).Trim()
            : string.Join(Environment.NewLine, "```csharp", code.Value.Trim(), "```");
    }

    /// <summary>Convert an XML element's content to inline Markdown.</summary>
    private static string InlineContent(XElement element)
    {
        var sb = new StringBuilder();
        foreach (var node in element.Nodes())
        {
            AppendInlineNode(sb, node);
        }

        return CollapseWhitespace(sb.ToString());
    }

    private static void AppendInlineNode(StringBuilder sb, XNode node)
    {
        if (node is XText text)
        {
            _ = sb.Append(text.Value);
        }
        else if (node is XElement child)
        {
            AppendInlineElement(sb, child);
        }
    }

    private static void AppendInlineElement(StringBuilder sb, XElement child)
    {
        _ = child.Name.LocalName switch
        {
            "see" => sb.Append('`')
                .Append(CrefToDisplay(child.Attribute("cref")?.Value))
                .Append('`'),
            "c" => sb.Append('`').Append(child.Value).Append('`'),
            "code" => sb.AppendLine()
                .AppendLine("```csharp")
                .AppendLine(child.Value.Trim())
                .AppendLine("```"),
            "para" => sb.AppendLine().AppendLine(),
            "paramref" or "typeparamref" => sb.Append('`')
                .Append(child.Attribute("name")?.Value ?? "?")
                .Append('`'),
            _ => sb.Append(child.Value),
        };
    }

    /// <summary>Strip the T:/M:/F:/P: prefix from a cref string.</summary>
    private static string CrefToDisplay(string? cref)
    {
        if (cref is null)
        {
            return "?";
        }

        var display = cref.Length >= 2 && cref[1] == ':' ? cref[2..] : cref;

        var lastDot = display.LastIndexOf('.');
        return lastDot >= 0 ? display[(lastDot + 1)..] : display;
    }

    private static string CollapseWhitespace(string text)
    {
        return CollapseWhitespaceRegex().Replace(text, " ");
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex CollapseWhitespaceRegex();
}
