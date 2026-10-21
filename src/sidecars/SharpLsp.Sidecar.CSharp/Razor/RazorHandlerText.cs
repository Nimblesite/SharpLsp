using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The text of a generated event handler and where it goes: before the closing brace of the
/// file's last <c>@code</c> or <c>@functions</c> block, else in a new <c>@code</c> block at the
/// end of the file. Implements [RAZOR-CODE-ACTIONS-HANDLER].
/// </summary>
internal static class RazorHandlerText
{
    private const string Indent = "    ";

    /// <summary>A private method named <paramref name="name"/>, taking the event's argument when there is one.</summary>
    public static IReadOnlyList<string> Method(string name, string? argument)
    {
        var parameters = argument is null ? "" : $"{argument} args";
        return [$"private void {name}({parameters})", "{", "}"];
    }

    /// <summary>The edit that inserts <paramref name="method"/> into <paramref name="markup"/>'s file.</summary>
    public static TextEditResult Insert(RazorMarkup markup, IReadOnlyList<string> method)
    {
        var text = markup.Text;
        var newline = LineBreak(text);
        var block = markup
            .Directives.Where(directive => directive.Name is "code" or "functions")
            .Select(directive => directive.Span)
            .Where(span => span.Length > 0 && text[span.End - 1] == '}')
            .OrderBy(span => span.End)
            .LastOrDefault();
        var body = string.Concat(method.Select(line => Indent + line + newline));
        var change =
            block.Length > 0
                ? new TextChange(new TextSpan(block.End - 1, 0), newline + body)
                : new TextChange(
                    new TextSpan(text.Length, 0),
                    (EndsWithLineBreak(text) ? "" : newline)
                        + newline
                        + "@code {"
                        + newline
                        + body
                        + "}"
                        + newline
                );
        return DocumentText.ToTextEdit(text, change);
    }

    /// <summary>The file's own line break, from its first line; <c>\n</c> for a one-line file.</summary>
    internal static string LineBreak(SourceText text)
    {
        var first = text.Lines[0];
        return first.EndIncludingLineBreak > first.End
            ? text.ToString(TextSpan.FromBounds(first.End, first.EndIncludingLineBreak))
            : "\n";
    }

    private static bool EndsWithLineBreak(SourceText text)
    {
        var last = text.Lines[^1];
        return text.Length == 0 || last.Span.Length == 0;
    }
}
