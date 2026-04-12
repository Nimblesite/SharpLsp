using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Forge.Sidecar.Common.Hover;

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
        RenderSummary(sb, root);
        RenderTypeParams(sb, root);
        RenderParams(sb, root);
        RenderReturns(sb, root);
        RenderRemarks(sb, root);
        RenderExceptions(sb, root);
        RenderExamples(sb, root);
        return sb.ToString().TrimEnd();
    }

    private static void RenderSummary(StringBuilder sb, XElement root)
    {
        var summary = root.Element("summary");
        if (summary is null)
        {
            return;
        }

        var text = InlineContent(summary).Trim();
        if (text.Length > 0)
        {
            _ = sb.AppendLine(text);
        }
    }

    private static void RenderTypeParams(StringBuilder sb, XElement root)
    {
        var typeParams = root.Elements("typeparam").ToList();
        if (typeParams.Count == 0)
        {
            return;
        }

        _ = sb.AppendLine();
        foreach (var tp in typeParams)
        {
            var name = tp.Attribute("name")?.Value ?? "T";
            var desc = InlineContent(tp).Trim();
            _ = sb.Append(CultureInfo.InvariantCulture, $"- `{name}`: {desc}").AppendLine();
        }
    }

    private static void RenderParams(StringBuilder sb, XElement root)
    {
        var parameters = root.Elements("param").ToList();
        if (parameters.Count == 0)
        {
            return;
        }

        _ = sb.AppendLine();
        _ = sb.AppendLine("**Parameters:**");
        foreach (var param in parameters)
        {
            var name = param.Attribute("name")?.Value ?? "?";
            var desc = InlineContent(param).Trim();
            _ = sb.Append(CultureInfo.InvariantCulture, $"- `{name}`: {desc}").AppendLine();
        }
    }

    private static void RenderReturns(StringBuilder sb, XElement root)
    {
        var returns = root.Element("returns");
        if (returns is null)
        {
            return;
        }

        var text = InlineContent(returns).Trim();
        if (text.Length > 0)
        {
            _ = sb.AppendLine();
            _ = sb.Append(CultureInfo.InvariantCulture, $"**Returns:** {text}").AppendLine();
        }
    }

    private static void RenderRemarks(StringBuilder sb, XElement root)
    {
        var remarks = root.Element("remarks");
        if (remarks is null)
        {
            return;
        }

        var text = InlineContent(remarks).Trim();
        if (text.Length > 0)
        {
            _ = sb.AppendLine();
            _ = sb.Append(CultureInfo.InvariantCulture, $"*{text}*").AppendLine();
        }
    }

    private static void RenderExceptions(StringBuilder sb, XElement root)
    {
        var exceptions = root.Elements("exception").ToList();
        if (exceptions.Count == 0)
        {
            return;
        }

        _ = sb.AppendLine();
        _ = sb.AppendLine("**Exceptions:**");
        foreach (var ex in exceptions)
        {
            var cref = CrefToDisplay(ex.Attribute("cref")?.Value);
            var desc = InlineContent(ex).Trim();
            _ = sb.Append(CultureInfo.InvariantCulture, $"- `{cref}` \u2014 {desc}").AppendLine();
        }
    }

    private static void RenderExamples(StringBuilder sb, XElement root)
    {
        var examples = root.Elements("example").ToList();
        if (examples.Count == 0)
        {
            return;
        }

        _ = sb.AppendLine();
        foreach (var example in examples)
        {
            var code = example.Element("code");
            if (code is not null)
            {
                _ = sb.AppendLine("```csharp");
                _ = sb.AppendLine(code.Value.Trim());
                _ = sb.AppendLine("```");
            }
            else
            {
                _ = sb.AppendLine(InlineContent(example).Trim());
            }
        }
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
