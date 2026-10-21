using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Completion in Razor markup, from the compiler's tag helpers. After <c>&lt;</c>: components,
/// by their short name where their namespace is in scope and their full name otherwise, and
/// inside a component its child-content parameters. In a start tag: the parameters not yet
/// set, <c>[EditorRequired]</c> ones first and marked, the attributes of the MVC tag helpers in
/// scope, then <c>@bind-X</c> and the directive attributes with their parameters. Each item
/// replaces the name typed at the caret. Implements [RAZOR-FEATURES-COMPLETION] and [RAZOR-MVC].
/// </summary>
internal static class RazorMarkupCompletion
{
    private const string Required = "Microsoft.AspNetCore.Components.EditorRequiredAttribute";

    private static readonly TagHelperKind[] DirectiveKinds =
    [
        TagHelperKind.EventHandler,
        TagHelperKind.Bind,
        TagHelperKind.Key,
        TagHelperKind.Ref,
        TagHelperKind.Splat,
        TagHelperKind.FormName,
        TagHelperKind.RenderMode,
    ];

    /// <summary>
    /// One item before it becomes a completion: what it inserts, its kind, detail and
    /// documentation, and the group it sorts in ahead of its label: child content and required
    /// parameters, then the rest, then directive attributes.
    /// </summary>
    private sealed record Entry(
        string Label,
        string Kind,
        string? Detail,
        string? Documentation,
        int Group
    );

    /// <summary>The items at <paramref name="offset"/>; null where markup completes nothing.</summary>
    public static List<CompletionItem>? At(RazorMarkup markup, Compilation compilation, int offset)
    {
        var context = markup.ContextAt(offset);
        var entries =
            context == MarkupContext.TagName ? TagEntries(markup, offset)
            : HtmlMarkupContext.StartTagAt(markup.HtmlText, offset) is { } spelled
                ? AttributeEntries(markup, compilation, OwnerAt(markup, offset, spelled), spelled)
            : null;
        var replace = TextSpan.FromBounds(HtmlMarkupContext.NameStart(markup.Text, offset), offset);
        return entries is null
            ? null
            : [.. entries.Select(entry => Item(entry, markup.Text, replace))];
    }

    /// <summary>
    /// The directives an <c>@</c> opening a markup line may begin, from the parser options for
    /// the file's kind, each replacing the <c>@</c> and what follows it; none elsewhere.
    /// </summary>
    public static List<CompletionItem> Directives(RazorMarkup markup, int offset)
    {
        var start = HtmlMarkupContext.NameStart(markup.Text, offset);
        var replace = TextSpan.FromBounds(start, offset);
        return HtmlMarkupContext.OpensLineWithTransition(markup.Text, start)
            ?
            [
                .. markup.AvailableDirectives.Select(directive =>
                    Item(
                        new Entry(
                            "@" + directive.Directive,
                            "Keyword",
                            directive.DisplayName,
                            directive.Description,
                            0
                        ),
                        markup.Text,
                        replace
                    )
                ),
            ]
            : [];
    }

    private static IEnumerable<Entry> TagEntries(RazorMarkup markup, int offset)
    {
        var parent = markup
            .Tags.Where(tag =>
                tag.Component is not null
                && tag.StartName.End < offset
                && tag.Element.Contains(offset)
            )
            .MinBy(tag => tag.Element.Length);
        var children = parent is null ? [] : ChildContents(markup, parent);
        return children.Concat(Components(markup)).Concat(TagHelperElements(markup.Scope));
    }

    /// <summary>
    /// Each element an MVC tag helper in scope targets by name (<c>partial</c>, <c>environment</c>,
    /// <c>a</c>), spelled with the scope's prefix, once, with the tag helpers that bind it. A rule
    /// for every element (<c>*</c>) names none. [RAZOR-MVC-TAGHELPERS]
    /// </summary>
    private static IEnumerable<Entry> TagHelperElements(RazorTagHelperScope scope)
    {
        return scope
            .TagHelpers.SelectMany(helper =>
                helper
                    .TagMatchingRules.Where(rule => rule.TagName is not (null or "*"))
                    .Select(rule => (Label: scope.Prefix + rule.TagName, Helper: helper))
            )
            .GroupBy(element => element.Label, StringComparer.OrdinalIgnoreCase)
            .Select(element => new Entry(
                element.Key,
                "Class",
                string.Join(", ", element.Select(bound => bound.Helper.Name).Distinct()),
                element.First().Helper.Documentation,
                1
            ));
    }

    /// <summary>
    /// Each component once: its short name where its namespace is in scope, else its full one.
    /// A legacy file binds no component by its tag, so it completes none. [RAZOR-MVC-SCOPE]
    /// </summary>
    private static IEnumerable<Entry> Components(RazorMarkup markup)
    {
        return markup
            .TagHelpers.Where(helper =>
                helper.Kind == TagHelperKind.Component && markup.FileKind != RazorFileKind.Legacy
            )
            .GroupBy(helper => helper.TypeName, StringComparer.Ordinal)
            .Select(group =>
                group.FirstOrDefault(helper =>
                    IsShortName(helper) == InScope(markup, helper.TypeNamespace)
                )
            )
            .OfType<TagHelperDescriptor>()
            .Select(helper => new Entry(
                TagName(helper),
                "Class",
                helper.TypeName,
                helper.Documentation,
                1
            ));
    }

    private static IEnumerable<Entry> ChildContents(RazorMarkup markup, MarkupTag parent)
    {
        return markup
            .TagHelpers.Where(helper =>
                helper.Kind == TagHelperKind.ChildContent
                && helper.TagMatchingRules.Any(rule => rule.ParentTag == parent.Name)
            )
            .Select(helper => new Entry(
                TagName(helper),
                "Property",
                null,
                helper.Documentation,
                0
            ));
    }

    /// <summary>
    /// The attributes not yet set on the start tag spelled <paramref name="spelled"/>: a
    /// component's parameters, the attributes its MVC tag helpers in scope bind, and in a
    /// component file the directive attributes.
    /// </summary>
    private static IEnumerable<Entry> AttributeEntries(
        RazorMarkup markup,
        Compilation compilation,
        MarkupTag? tag,
        string spelled
    )
    {
        var set = markup
            .Attributes.Where(attribute => attribute.Owner == tag)
            .Select(attribute => attribute.Name)
            .ToHashSet(StringComparer.Ordinal);
        var parameters = tag?.Component is { } component ? Parameters(compilation, component) : [];
        var helpers = markup.Scope.Targeting(spelled).SelectMany(TagHelperEntries);
        var directives =
            markup.FileKind == RazorFileKind.Component
                ? markup
                    .TagHelpers.Where(helper =>
                        DirectiveKinds.Contains(helper.Kind)
                        && Applies(helper, tag?.Name ?? spelled)
                    )
                    .SelectMany(DirectiveEntries)
                : [];
        return parameters
            .Concat(helpers)
            .Concat(directives)
            .Where(entry => !set.Contains(entry.Label))
            .DistinctBy(entry => entry.Label);
    }

    /// <summary>An MVC tag helper's attributes, and each indexer's prefix (<c>asp-route-</c>).</summary>
    private static IEnumerable<Entry> TagHelperEntries(TagHelperDescriptor helper)
    {
        return helper.BoundAttributes.SelectMany(attribute =>
            new[]
            {
                (Label: attribute.Name, Type: attribute.TypeName),
                (Label: attribute.IndexerNamePrefix, Type: attribute.IndexerTypeName),
            }
                .Where(named => !string.IsNullOrEmpty(named.Label))
                .Select(named => new Entry(
                    named.Label!,
                    "Property",
                    named.Type,
                    attribute.Documentation,
                    1
                ))
        );
    }

    /// <summary>A component's parameters; one its property marks <c>[EditorRequired]</c> sorts first.</summary>
    private static IEnumerable<Entry> Parameters(
        Compilation compilation,
        TagHelperDescriptor component
    )
    {
        var type = RazorMarkupSymbols.TypeOf(compilation, component);
        var required = compilation.GetTypeByMetadataName(Required);
        return component.BoundAttributes.Select(parameter =>
        {
            var property = type is null
                ? null
                : RazorMarkupSymbols.PropertyOf(type, parameter.PropertyName);
            var isRequired =
                property
                    ?.GetAttributes()
                    .Any(attribute =>
                        SymbolEqualityComparer.Default.Equals(attribute.AttributeClass, required)
                    ) == true;
            var detail = isRequired ? $"required · {parameter.TypeName}" : parameter.TypeName;
            return new Entry(
                parameter.Name,
                "Property",
                detail,
                parameter.Documentation,
                isRequired ? 0 : 1
            );
        });
    }

    /// <summary>A directive attribute, then each of its parameters as <c>@name:parameter</c>.</summary>
    private static IEnumerable<Entry> DirectiveEntries(TagHelperDescriptor helper)
    {
        return helper.BoundAttributes.SelectMany(attribute =>
            attribute
                .Parameters.Select(parameter => new Entry(
                    $"{attribute.Name}:{parameter.Name}",
                    "Keyword",
                    parameter.TypeName,
                    parameter.Documentation,
                    2
                ))
                .Prepend(
                    new Entry(
                        attribute.Name,
                        "Keyword",
                        attribute.TypeName,
                        attribute.Documentation,
                        2
                    )
                )
        );
    }

    /// <summary>Whether a directive attribute's tag helper targets a tag named <paramref name="name"/>.</summary>
    private static bool Applies(TagHelperDescriptor helper, string name)
    {
        return helper.TagMatchingRules.Any(rule => RazorTagHelperScope.Targets(rule, name));
    }

    /// <summary>
    /// The tag whose start tag holds <paramref name="offset"/>: the innermost one holding the
    /// caret whose name is spelled as the tokenizer read it. A legacy file's plain HTML element
    /// is no tag, so none owns its start tag.
    /// </summary>
    private static MarkupTag? OwnerAt(RazorMarkup markup, int offset, string spelled)
    {
        return markup
            .Tags.Where(tag =>
                tag.StartName.End <= offset
                && tag.Element.Start < offset
                && offset <= tag.Element.End
                && string.Equals(
                    markup.Text.ToString(tag.StartName),
                    spelled,
                    StringComparison.OrdinalIgnoreCase
                )
            )
            .MaxBy(tag => tag.StartName.Start);
    }

    /// <summary>
    /// Whether components of <paramref name="typeNamespace"/> bind by their short name: the
    /// file's own namespace, one that contains it, or one it imports.
    /// </summary>
    private static bool InScope(RazorMarkup markup, string? typeNamespace)
    {
        var own = markup.Namespace ?? "";
        return string.IsNullOrEmpty(typeNamespace)
            || own == typeNamespace
            || own.StartsWith(typeNamespace + ".", StringComparison.Ordinal)
            || markup.ImportedNamespaces.Contains(typeNamespace);
    }

    private static bool IsShortName(TagHelperDescriptor helper)
    {
        return TagName(helper) == helper.TypeNameIdentifier;
    }

    private static string TagName(TagHelperDescriptor helper)
    {
        return helper.TagMatchingRules.FirstOrDefault()?.TagName ?? helper.Name;
    }

    private static CompletionItem Item(Entry entry, SourceText text, TextSpan replace)
    {
        return new CompletionItem
        {
            Label = entry.Label,
            Kind = entry.Kind,
            Detail = entry.Detail,
            Documentation = entry.Documentation,
            SortText = $"{entry.Group}{entry.Label}",
            Index = -1,
            TextEdit = DocumentText.ToTextEdit(text, new TextChange(replace, entry.Label)),
        };
    }
}
