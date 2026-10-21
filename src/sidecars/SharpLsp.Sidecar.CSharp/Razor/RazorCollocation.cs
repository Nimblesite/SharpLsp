using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A Razor file's collocated files: the stylesheet that scopes a component's CSS
/// (<c>Card.razor.css</c>) and the JavaScript module it imports (<c>Card.razor.js</c>). The
/// stylesheet's classes complete and define inside a <c>class</c> attribute value, and an
/// <c>InvokeAsync&lt;IJSObjectReference&gt;("import", "…")</c> call defines to its module.
/// Implements [RAZOR-COLLOCATION].
/// </summary>
internal static class RazorCollocation
{
    /// <summary>The types whose <c>InvokeAsync</c> imports a JavaScript module.</summary>
    private static readonly string[] JruntimeTypes =
    [
        "Microsoft.JSInterop.IJSRuntime",
        "Microsoft.JSInterop.IJSObjectReference",
    ];

    /// <summary>
    /// The <c>class</c> attribute value holding <paramref name="offset"/>, with the class name
    /// the caret is in: the whole token between whitespace, not the whole value. Null wherever the
    /// attribute is not a plain HTML <c>class</c>, a directive attribute and a component's own
    /// parameter never counting. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    public static (TextSpan Value, TextSpan Class)? ClassValueAt(RazorMarkup markup, int offset)
    {
        return
            HtmlMarkupContext.AttributeAt(markup.HtmlText, offset) is { } attribute
            && IsHtmlClass(markup, attribute)
            && attribute.Value is { } value
            && value.Start <= offset
            && offset <= value.End
            ? (value, TokenAt(markup.HtmlText, value, offset))
            : null;
    }

    /// <summary>
    /// The items for the classes <paramref name="stylesheet"/> declares, each once, replacing the
    /// class name at the caret and naming the stylesheet. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    public static List<CompletionItem> ClassCompletions(
        RazorMarkup markup,
        RazorStylesheet stylesheet,
        (TextSpan Value, TextSpan Class) at
    )
    {
        return
        [
            .. stylesheet.Names.Select(name => new CompletionItem
            {
                Label = name,
                Kind = "Value",
                Detail = NativePaths.NameOf(stylesheet.FilePath),
                SortText = name,
                Index = -1,
                TextEdit = DocumentText.ToTextEdit(markup.Text, new TextChange(at.Class, name)),
            }),
        ];
    }

    /// <summary>
    /// The definitions of the class name at the caret: every selector occurrence of that class in
    /// the stylesheet, each ranged on the name after its <c>.</c>. [RAZOR-COLLOCATION-CSS]
    /// </summary>
    public static LocationListResult ClassDefinitions(
        RazorMarkup markup,
        RazorStylesheet stylesheet,
        (TextSpan Value, TextSpan Class) at
    )
    {
        var name = markup.Text.ToString(at.Class);
        return new LocationListResult
        {
            Locations =
            [
                .. stylesheet
                    .Classes.Where(cssClass => cssClass.Name == name)
                    .Select(cssClass => ToLocation(stylesheet, cssClass)),
            ],
        };
    }

    /// <summary>The name a module import at <paramref name="offset"/> passes to <c>InvokeAsync</c>; null elsewhere.</summary>
    public static LiteralExpressionSyntax? ModuleLiteral(SyntaxNode root, int offset)
    {
        var token = root.FindToken(Math.Clamp(offset, 0, root.FullSpan.End));
        return
            token.Parent is LiteralExpressionSyntax literal
            && literal.IsKind(SyntaxKind.StringLiteralExpression)
            && literal.Span.Contains(offset)
            ? literal
            : null;
    }

    /// <summary>
    /// The module path <paramref name="literal"/> names, when the call it is part of passes the
    /// constant <c>"import"</c> to an <c>IJSRuntime</c> or <c>IJSObjectReference</c>
    /// <c>InvokeAsync</c>. Resolved with the semantic model, never by reading text.
    /// [RAZOR-COLLOCATION-JS]
    /// </summary>
    public static string? ImportedModule(
        SemanticModel model,
        LiteralExpressionSyntax literal,
        CancellationToken ct
    )
    {
        return
            ImportCall(literal) is { } call
            && ImportsModule(model, call, ct)
            && model.GetConstantValue(literal, ct) is { HasValue: true, Value: string path }
            ? path
            : null;
    }

    /// <summary>
    /// The file a module path names: the leading <c>./</c> and the app's base path both resolve
    /// against the project directory, and only a <c>.razor.js</c> or <c>.cshtml.js</c> is a module.
    /// [RAZOR-COLLOCATION-JS]
    /// </summary>
    public static string? ModuleFile(string projectDirectory, string path)
    {
        return
            NativePaths.FromModulePath(projectDirectory, path) is { } resolved
            && (
                NativePaths.HasExtension(resolved, ".razor.js")
                || NativePaths.HasExtension(resolved, ".cshtml.js")
            )
            ? resolved
            : null;
    }

    /// <summary>Whether the attribute names the plain HTML <c>class</c>, unbound by any tag helper.</summary>
    private static bool IsHtmlClass(
        RazorMarkup markup,
        (string Name, TextSpan NameSpan, TextSpan? Value) attribute
    )
    {
        return string.Equals(attribute.Name, "class", StringComparison.OrdinalIgnoreCase)
            && !markup.Attributes.Any(fact =>
                fact.Kind != MarkupAttributeKind.Html
                && fact.NameSpan is { } name
                && name.IntersectsWith(attribute.NameSpan)
            );
    }

    /// <summary>The whole class name holding <paramref name="offset"/>, kept inside the value.</summary>
    private static TextSpan TokenAt(string html, TextSpan value, int offset)
    {
        var start = Math.Clamp(offset, value.Start, value.End);
        var end = start;
        while (start > value.Start && !HtmlMarkupContext.IsSpace(html[start - 1]))
        {
            start--;
        }

        while (end < value.End && !HtmlMarkupContext.IsSpace(html[end]))
        {
            end++;
        }

        return TextSpan.FromBounds(start, end);
    }

    private static LocationResult ToLocation(RazorStylesheet stylesheet, CssClass cssClass)
    {
        var start = stylesheet.Text.Lines.GetLinePosition(cssClass.Span.Start);
        var end = stylesheet.Text.Lines.GetLinePosition(cssClass.Span.End);
        return new LocationResult
        {
            FilePath = stylesheet.FilePath,
            Line = start.Line,
            Character = start.Character,
            EndLine = end.Line,
            EndCharacter = end.Character,
        };
    }

    /// <summary>The call the literal is the second argument of; null when it is not one.</summary>
    private static InvocationExpressionSyntax? ImportCall(LiteralExpressionSyntax literal)
    {
        return
            literal.Ancestors().OfType<ArgumentSyntax>().FirstOrDefault()
                is { Parent: ArgumentListSyntax list } argument
            && list.Arguments.IndexOf(argument) == 1
            && list.Parent is InvocationExpressionSyntax call
            ? call
            : null;
    }

    /// <summary>
    /// Whether the call is an <c>InvokeAsync</c> of a JavaScript runtime whose first argument is the
    /// constant <c>"import"</c>.
    /// </summary>
    private static bool ImportsModule(
        SemanticModel model,
        InvocationExpressionSyntax call,
        CancellationToken ct
    )
    {
        return model.GetConstantValue(call.ArgumentList.Arguments[0].Expression, ct)
                is { HasValue: true, Value: "import" }
            && model.GetSymbolInfo(call, ct).Symbol is IMethodSymbol method
            && method.Name == "InvokeAsync"
            && IsRuntime(model.Compilation, method);
    }

    /// <summary>
    /// Whether the call runs on a JavaScript runtime: its declaring type, or its receiver, is
    /// <c>IJSRuntime</c> or <c>IJSObjectReference</c>. The <c>params object?[]</c> overload is an
    /// extension method called on the runtime, so its receiver is the runtime; called as a static
    /// method it passes the path third, which no import names.
    /// </summary>
    private static bool IsRuntime(Compilation compilation, IMethodSymbol method)
    {
        var runtimes = JruntimeTypes
            .Select(compilation.GetTypeByMetadataName)
            .OfType<INamedTypeSymbol>();
        return new ITypeSymbol?[] { method.ContainingType, method.ReceiverType }.Any(receiver =>
            runtimes.Any(runtime => IsOrImplements(receiver, runtime))
        );
    }

    private static bool IsOrImplements(ITypeSymbol? type, INamedTypeSymbol runtime)
    {
        return type is not null
            && (
                SymbolEqualityComparer.Default.Equals(type, runtime)
                || type.AllInterfaces.Any(iface =>
                    SymbolEqualityComparer.Default.Equals(iface, runtime)
                )
            );
    }
}
