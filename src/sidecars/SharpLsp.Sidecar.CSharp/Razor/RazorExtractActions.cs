using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Razor refactorings that move markup or code into a new file: a component's <c>@code</c>
/// block into a code-behind partial class, and a run of sibling elements into a new
/// component. Implements [RAZOR-CODE-ACTIONS-CODE-BEHIND] and [RAZOR-CODE-ACTIONS-COMPONENT].
/// </summary>
internal static class RazorExtractActions
{
    /// <summary>
    /// Move the <c>@code</c> block whose name holds the caret into <c>Name.razor.cs</c>, when the
    /// component has no code-behind yet. The partial class carries the file's imported
    /// namespaces that the project does not import globally.
    /// </summary>
    public static RazorCodeAction? CodeBehind(
        RazorProjection projection,
        RazorMarkup markup,
        Compilation compilation,
        int caret
    )
    {
        // The caret may sit on the directive's `@` as well as on its name.
        var block = markup.Directives.FirstOrDefault(directive =>
            directive.Span.Start <= caret && caret <= directive.NameSpan.End
        );
        var path = NativePaths.CodeBehindOf(projection.RazorPath);
        var body = block is { Name: "code" } ? BodyOf(projection, block.Span) : null;
        if (markup.FileKind != RazorFileKind.Component || body is null || File.Exists(path))
        {
            return null;
        }

        var name = NativePaths.StemOf(projection.RazorPath);
        var newline = RazorHandlerText.LineBreak(markup.Text);
        var text = PartialClass(
            markup,
            compilation,
            name,
            markup.Text.ToString(body.Value),
            newline
        );
        var removed = WithLineBreak(markup.Text, block!.Span);
        return new RazorCodeAction(
            "Extract block to code behind",
            "refactor.extract",
            false,
            Edits(markup.Text, projection.RazorPath, new TextChange(removed, ""), path, text)
        );
    }

    /// <summary>
    /// Move the sibling elements the selection covers into a new component beside the file,
    /// and put its tag in their place. Offered only when their C# names nothing the
    /// component or an enclosing block declares, which the new component could not see.
    /// </summary>
    public static RazorCodeAction? Component(
        RazorProjection projection,
        RazorMarkup markup,
        SemanticModel model,
        TextSpan range
    )
    {
        var selected = Trimmed(markup.Text, range);
        if (
            markup.FileKind != RazorFileKind.Component
            || !CoversSiblings(markup, selected)
            || !StandsAlone(projection, model, selected)
        )
        {
            return null;
        }

        var folder = NativePaths.DirectoryOf(projection.RazorPath);
        var name = FreeName(folder);
        var newline = RazorHandlerText.LineBreak(markup.Text);
        var text = ComponentText(markup, selected, newline);
        return new RazorCodeAction(
            $"Extract element to new component '{name}'",
            "refactor.extract",
            false,
            Edits(
                markup.Text,
                projection.RazorPath,
                new TextChange(selected, $"<{name} />"),
                NativePaths.ComponentIn(folder, name),
                text
            )
        );
    }

    /// <summary>The C# of a block: from its first fragment's start to its last fragment's end.</summary>
    private static TextSpan? BodyOf(RazorProjection projection, TextSpan block)
    {
        var inside = projection
            .Map.Mappings.Where(mapping =>
                block.Start <= mapping.RazorStart && mapping.RazorEnd <= block.End
            )
            .ToList();
        return inside.Count == 0
            ? null
            : TextSpan.FromBounds(inside.Min(m => m.RazorStart), inside.Max(m => m.RazorEnd));
    }

    private static string PartialClass(
        RazorMarkup markup,
        Compilation compilation,
        string name,
        string body,
        string newline
    )
    {
        var global = GlobalUsings(compilation);
        var usings = markup
            .ImportedNamespaces.Where(space => !global.Contains(space))
            .Distinct()
            .Order(StringComparer.Ordinal)
            .Select(space => $"using {space};{newline}");
        var space = markup.Namespace is { Length: > 0 } declared
            ? $"namespace {declared};{newline}{newline}"
            : "";
        var members = body.Trim('\r', '\n').TrimEnd();
        return string.Concat(usings)
            + (global.Count < markup.ImportedNamespaces.Length ? newline : "")
            + space
            + $"public partial class {name}{newline}{{{newline}{members}{newline}}}{newline}";
    }

    /// <summary>The namespaces the compilation imports with <c>global using</c>, as their symbols name them.</summary>
    private static HashSet<string> GlobalUsings(Compilation compilation)
    {
        return compilation
            .SyntaxTrees.SelectMany(tree =>
                tree.GetCompilationUnitRoot()
                    .Usings.Where(directive =>
                        directive.GlobalKeyword.Span.Length > 0 && directive.Alias is null
                    )
                    .Select(directive =>
                        compilation
                            .GetSemanticModel(tree)
                            .GetSymbolInfo(directive.NamespaceOrType)
                            .Symbol
                    )
            )
            .OfType<INamespaceSymbol>()
            .Select(space => space.ToDisplayString())
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary><paramref name="span"/> with the line break that follows it, so no blank line stays.</summary>
    private static TextSpan WithLineBreak(SourceText text, TextSpan span)
    {
        var line = text.Lines.GetLineFromPosition(span.End);
        return line.End == span.End
            ? TextSpan.FromBounds(span.Start, line.EndIncludingLineBreak)
            : span;
    }

    /// <summary><paramref name="range"/> without the whitespace at either end.</summary>
    private static TextSpan Trimmed(SourceText text, TextSpan range)
    {
        var start = range.Start;
        var end = range.End;
        while (start < end && char.IsWhiteSpace(text[start]))
        {
            start++;
        }

        while (end > start && char.IsWhiteSpace(text[end - 1]))
        {
            end--;
        }

        return TextSpan.FromBounds(start, end);
    }

    /// <summary>Whether <paramref name="selected"/> starts at one element and ends at a sibling's end.</summary>
    private static bool CoversSiblings(RazorMarkup markup, TextSpan selected)
    {
        var first = markup
            .Tags.Where(tag => tag.Element.Start == selected.Start)
            .MaxBy(tag => tag.Element.Length);
        var last = markup
            .Tags.Where(tag => tag.Element.End == selected.End)
            .MaxBy(tag => tag.Element.Length);
        return selected.Length > 0
            && first is not null
            && last is not null
            && (first == last || first.Element.End <= last.Element.Start)
            && Parent(markup, first) == Parent(markup, last);
    }

    private static MarkupTag? Parent(RazorMarkup markup, MarkupTag tag)
    {
        return markup
            .Tags.Where(other => other != tag && other.Element.Contains(tag.Element))
            .MinBy(other => other.Element.Length);
    }

    /// <summary>
    /// Whether the selection's C# binds only to what it declares itself or what any component
    /// can name: never a member of this component, nor a local or parameter declared outside it.
    /// </summary>
    private static bool StandsAlone(
        RazorProjection projection,
        SemanticModel model,
        TextSpan selected
    )
    {
        var generated = projection
            .Map.Mappings.Where(mapping =>
                selected.Start <= mapping.RazorStart && mapping.RazorEnd <= selected.End
            )
            .Select(mapping => new TextSpan(mapping.GeneratedStart, mapping.Length))
            .ToList();
        var component = model.GetDeclaredSymbol(
            projection.GeneratedRoot.DescendantNodes().OfType<ClassDeclarationSyntax>().First()
        );
        return generated
            .SelectMany(span =>
                projection.GeneratedRoot.DescendantNodes(span).OfType<IdentifierNameSyntax>()
            )
            .Where(name => generated.Any(span => span.Contains(name.Span)))
            .Select(name => model.GetSymbolInfo(name).Symbol)
            .OfType<ISymbol>()
            .All(symbol => !Captures(symbol, component, generated));
    }

    private static bool Captures(
        ISymbol symbol,
        INamedTypeSymbol? component,
        List<TextSpan> selected
    )
    {
        var declaredInside = symbol.Locations.Any(location =>
            location.IsInSource && selected.Any(span => span.Contains(location.SourceSpan))
        );
        return symbol switch
        {
            ILocalSymbol or IParameterSymbol or IRangeVariableSymbol => !declaredInside,
            _ => SymbolEqualityComparer.Default.Equals(symbol.ContainingType, component),
        };
    }

    /// <summary><c>Component</c>, else the first <c>ComponentN</c> no file in the folder takes.</summary>
    private static string FreeName(string folder)
    {
        return Enumerable
            .Range(1, int.MaxValue - 1)
            .Select(n => n == 1 ? "Component" : $"Component{n}")
            .First(name => !File.Exists(NativePaths.ComponentIn(folder, name)));
    }

    /// <summary>The new component: the file's own <c>@using</c> lines, then the elements, dedented.</summary>
    private static string ComponentText(RazorMarkup markup, TextSpan selected, string newline)
    {
        var usings = markup
            .Directives.Where(directive => directive.Name == "using")
            .Select(directive => markup.Text.ToString(directive.Span).TrimEnd() + newline);
        var text = markup.Text;
        var first = text.Lines.GetLineFromPosition(selected.Start);
        var indent = selected.Start - first.Start;
        var lines = Enumerable
            .Range(
                first.LineNumber,
                text.Lines.GetLineFromPosition(selected.End).LineNumber - first.LineNumber + 1
            )
            .Select(number => text.Lines[number])
            .Select(line =>
                text.ToString(
                    TextSpan.FromBounds(
                        Math.Max(
                            line.Start,
                            line == first ? selected.Start : Dedented(text, line, indent)
                        ),
                        Math.Min(line.End, selected.End)
                    )
                )
            );
        var head = string.Concat(usings);
        return head + (head.Length > 0 ? newline : "") + string.Join(newline, lines) + newline;
    }

    /// <summary>Where <paramref name="line"/>'s text starts once up to <paramref name="indent"/> of its leading whitespace is dropped.</summary>
    private static int Dedented(SourceText text, TextLine line, int indent)
    {
        var start = line.Start;
        while (start < line.End && start - line.Start < indent && char.IsWhiteSpace(text[start]))
        {
            start++;
        }

        return start;
    }

    /// <summary>The edit to the Razor file and the new file's whole text, the new file first.</summary>
    private static WorkspaceEditResult Edits(
        SourceText razorText,
        string razorPath,
        TextChange change,
        string newPath,
        string newText
    )
    {
        return new WorkspaceEditResult
        {
            DocumentChanges =
            [
                new DocumentEditResult
                {
                    FilePath = newPath,
                    Edits = [new TextEditResult { NewText = newText }],
                    Create = true,
                },
                new DocumentEditResult
                {
                    FilePath = razorPath,
                    Edits = [DocumentText.ToTextEdit(razorText, change)],
                },
            ],
        };
    }
}
