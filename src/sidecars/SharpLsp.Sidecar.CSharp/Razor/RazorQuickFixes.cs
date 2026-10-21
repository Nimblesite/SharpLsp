using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>A Razor code action, its edit computed when it is offered.</summary>
internal sealed record RazorCodeAction(
    string Title,
    string Kind,
    bool IsPreferred,
    WorkspaceEditResult Edit
);

/// <summary>
/// Razor quick fixes for C# names the projection cannot bind: <c>@using</c> for a type
/// another namespace declares, and a handler method for an event attribute or
/// <c>EventCallback</c> parameter that names one not yet written. Implements
/// [RAZOR-CODE-ACTIONS-USING] and [RAZOR-CODE-ACTIONS-HANDLER].
/// </summary>
internal static class RazorQuickFixes
{
    /// <summary>The C# diagnostics that name something the projection cannot find.</summary>
    private static readonly string[] Unbound = ["CS0103", "CS0246"];

    /// <summary>The fixes for the projection's unbound names that lie in <paramref name="range"/>.</summary>
    public static async Task<IEnumerable<RazorCodeAction>> ForAsync(
        RazorProjection projection,
        RazorMarkup markup,
        TextSpan range,
        CancellationToken ct
    )
    {
        var model =
            await projection.Generated.GetSemanticModelAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The projection has no semantic model");
        var names = model
            .GetDiagnostics(cancellationToken: ct)
            .Where(diagnostic => Unbound.Contains(diagnostic.Id))
            .Select(diagnostic => UnboundName(projection, diagnostic, range))
            .OfType<SimpleNameSyntax>()
            .DistinctBy(name => name.SpanStart);
        var fixes = new List<RazorCodeAction>();
        foreach (var name in names)
        {
            fixes.AddRange(
                await UsingsAsync(projection, markup, model, name, ct).ConfigureAwait(false)
            );
            fixes.AddRange(Handlers(projection, markup, model, name));
        }

        return fixes
            .Concat(ComponentUsings(projection, markup, range))
            .DistinctBy(fix => fix.Title);
    }

    /// <summary>The name a diagnostic reports, when its Razor span overlaps <paramref name="range"/>.</summary>
    private static SimpleNameSyntax? UnboundName(
        RazorProjection projection,
        Diagnostic diagnostic,
        TextSpan range
    )
    {
        var span = diagnostic.Location.SourceSpan;
        var razor = projection.Map.ToRazor(span);
        return razor is { } mapped && (mapped.OverlapsWith(range) || mapped.Contains(range.Start))
            ? projection
                .GeneratedRoot.FindNode(span, getInnermostNodeForTie: true)
                .DescendantNodesAndSelf()
                .OfType<SimpleNameSyntax>()
                .FirstOrDefault()
            : null;
    }

    /// <summary>
    /// <c>@using</c> for each namespace that declares an accessible type of the unbound name
    /// and arity, which the file does not import yet; one choice is preferred.
    /// </summary>
    private static async Task<IEnumerable<RazorCodeAction>> UsingsAsync(
        RazorProjection projection,
        RazorMarkup markup,
        SemanticModel model,
        SimpleNameSyntax name,
        CancellationToken ct
    )
    {
        var arity = name is GenericNameSyntax generic
            ? generic.TypeArgumentList.Arguments.Count
            : 0;
        var declared = await SymbolFinder
            .FindDeclarationsAsync(
                projection.Generated.Project,
                name.Identifier.ValueText,
                ignoreCase: false,
                SymbolFilter.Type,
                ct
            )
            .ConfigureAwait(false);
        var namespaces = declared
            .OfType<INamedTypeSymbol>()
            .Where(type =>
                type.Arity == arity
                && type.ContainingType is null
                && model.IsAccessible(name.SpanStart, type)
                && !type.ContainingNamespace.IsGlobalNamespace
            )
            .Select(type => type.ContainingNamespace.ToDisplayString())
            .Where(space => !markup.ImportedNamespaces.Contains(space))
            .Distinct()
            .Order(StringComparer.Ordinal)
            .ToList();
        return namespaces.Select(space =>
            UsingFix(projection, markup, space, namespaces.Count == 1)
        );
    }

    /// <summary>
    /// <c>@using</c> for each namespace holding a component that an unknown element names
    /// (<c>RZ10012</c>): the compiler binds a component tag only where its namespace is in scope.
    /// </summary>
    private static IEnumerable<RazorCodeAction> ComponentUsings(
        RazorProjection projection,
        RazorMarkup markup,
        TextSpan range
    )
    {
        var spans = markup
            .Diagnostics.Where(diagnostic =>
                diagnostic.Id == "RZ10012"
                && (diagnostic.Span.OverlapsWith(range) || diagnostic.Span.Contains(range.Start))
            )
            .Select(diagnostic => diagnostic.Span)
            .ToList();
        var unknown = markup
            .Tags.Where(tag => spans.Any(span => span.Contains(tag.StartName.Start)))
            .Select(tag => tag.Name)
            .ToHashSet(StringComparer.Ordinal);
        return markup
            .TagHelpers.Where(helper =>
                helper.Kind == TagHelperKind.Component
                && unknown.Contains(helper.TypeNameIdentifier ?? "")
                && helper.TypeNamespace is { Length: > 0 } space
                && !markup.ImportedNamespaces.Contains(space)
            )
            .Select(helper => helper.TypeNamespace!)
            .Distinct()
            .Select(space => UsingFix(projection, markup, space, true));
    }

    private static RazorCodeAction UsingFix(
        RazorProjection projection,
        RazorMarkup markup,
        string space,
        bool preferred
    )
    {
        var line = RazorCompletionEdits.Map(
            projection,
            [new TextChange(new TextSpan(0, 0), $"using {space};")],
            markup
        );
        return new RazorCodeAction(
            $"@using {space}",
            "quickfix",
            preferred,
            Edit(projection.RazorPath, line)
        );
    }

    /// <summary>
    /// A handler for an unbound name that the projection passes to
    /// <c>EventCallback.Factory.Create</c>: an event attribute (<c>@onclick="Missing"</c>) or an
    /// <c>EventCallback</c> parameter. It takes the event's argument when the callback has one.
    /// </summary>
    private static IEnumerable<RazorCodeAction> Handlers(
        RazorProjection projection,
        RazorMarkup markup,
        SemanticModel model,
        SimpleNameSyntax name
    )
    {
        var create = name.Ancestors()
            .OfType<InvocationExpressionSyntax>()
            .FirstOrDefault(invocation => CreatesCallback(model, invocation));
        if (create is null || name is GenericNameSyntax)
        {
            return [];
        }

        var argument = CallbackArgument(model, create, name.SpanStart);
        var method = RazorHandlerText.Method(name.Identifier.ValueText, argument);
        return
        [
            new RazorCodeAction(
                $"Generate event handler '{name.Identifier.ValueText}'",
                "quickfix",
                true,
                Edit(projection.RazorPath, [RazorHandlerText.Insert(markup, method)])
            ),
        ];
    }

    /// <summary>Whether <paramref name="invocation"/> calls <c>EventCallbackFactory.Create</c>.</summary>
    private static bool CreatesCallback(SemanticModel model, InvocationExpressionSyntax invocation)
    {
        var info = model.GetSymbolInfo(invocation);
        return info
            .CandidateSymbols.Append(info.Symbol)
            .OfType<IMethodSymbol>()
            .Any(method =>
                method.Name == "Create"
                && method.ContainingType.ToDisplayString()
                    == "Microsoft.AspNetCore.Components.EventCallbackFactory"
            );
    }

    /// <summary>The callback's argument type, as the file spells it, from the call's type argument; none for a plain <c>EventCallback</c>.</summary>
    private static string? CallbackArgument(
        SemanticModel model,
        InvocationExpressionSyntax create,
        int position
    )
    {
        var argument = create.Expression switch
        {
            MemberAccessExpressionSyntax { Name: GenericNameSyntax generic } =>
                generic.TypeArgumentList.Arguments.FirstOrDefault(),
            _ => null,
        };
        return argument is null
            ? null
            : model.GetTypeInfo(argument).Type?.ToMinimalDisplayString(model, position);
    }

    private static WorkspaceEditResult Edit(string path, IEnumerable<TextEditResult> edits)
    {
        return new WorkspaceEditResult
        {
            DocumentChanges = [new DocumentEditResult { FilePath = path, Edits = [.. edits] }],
        };
    }
}
