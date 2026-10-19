using System.Collections.Immutable;
using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>What a markup attribute is to the compiler.</summary>
internal enum MarkupAttributeKind
{
    /// <summary>A component parameter or tag helper property: <c>Title="…"</c>, <c>asp-for="…"</c>.</summary>
    Property,

    /// <summary>A directive attribute: <c>@onclick</c>, <c>@bind-Value</c>, <c>@ref</c>.</summary>
    Directive,

    /// <summary>A directive attribute parameter: <c>@bind:event</c>, <c>@onclick:preventDefault</c>.</summary>
    DirectiveParameter,

    /// <summary>An attribute no tag helper binds.</summary>
    Html,
}

/// <summary>An element of the file, with the tag helpers (components included) the compiler bound to it.</summary>
internal sealed record MarkupTag(
    string Name,
    TextSpan Element,
    TextSpan StartName,
    TextSpan? EndName,
    ImmutableArray<TagHelperDescriptor> TagHelpers
)
{
    /// <summary>The component this tag instantiates, if any.</summary>
    public TagHelperDescriptor? Component =>
        TagHelpers.FirstOrDefault(helper => helper.Kind == TagHelperKind.Component);

    /// <summary>The child-content parameter this tag sets, if any (<c>&lt;ChildContent&gt;</c>).</summary>
    public TagHelperDescriptor? ChildContent =>
        TagHelpers.FirstOrDefault(helper => helper.Kind == TagHelperKind.ChildContent);

    /// <summary>The MVC tag helpers bound to this tag.</summary>
    public IEnumerable<TagHelperDescriptor> MvcTagHelpers =>
        TagHelpers.Where(helper =>
            helper.Kind is TagHelperKind.ITagHelper or TagHelperKind.ViewComponent
        );

    /// <summary>Whether <paramref name="offset"/> lies on the start or end tag's name.</summary>
    public bool NameContains(int offset)
    {
        return Touches(StartName, offset) || (EndName is { } end && Touches(end, offset));
    }

    private static bool Touches(TextSpan span, int offset)
    {
        return span.Start <= offset && offset <= span.End;
    }
}

/// <summary>An attribute of a tag, with what binds it.</summary>
internal sealed record MarkupAttribute(
    MarkupAttributeKind Kind,
    string Name,
    TextSpan? NameSpan,
    MarkupTag Owner,
    TagHelperDescriptor? TagHelper,
    BoundAttributeDescriptor? Bound,
    BoundAttributeParameterDescriptor? Parameter
);

/// <summary>A directive the file declares: <c>@page</c>, <c>@inject</c>, <c>@code</c>, <c>@using</c>.</summary>
internal sealed record MarkupDirective(
    string Name,
    TextSpan Span,
    TextSpan NameSpan,
    DirectiveDescriptor? Descriptor
);

/// <summary>A Razor (<c>RZ</c>) diagnostic of the file.</summary>
internal sealed record MarkupDiagnostic(
    string Id,
    string Message,
    RazorDiagnosticSeverity Severity,
    TextSpan Span
);

/// <summary>
/// A Razor file's markup facts, read from the compiler's intermediate representation.
/// Implements [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
internal sealed record RazorMarkup(
    SourceText Text,
    RazorFileKind FileKind,
    string? Namespace,
    ImmutableArray<string> ImportedNamespaces,
    ImmutableArray<MarkupTag> Tags,
    ImmutableArray<MarkupAttribute> Attributes,
    ImmutableArray<MarkupDirective> Directives,
    ImmutableArray<MarkupDiagnostic> Diagnostics,
    ImmutableArray<DirectiveDescriptor> AvailableDirectives,
    TagHelperCollection TagHelpers
)
{
    /// <summary>The innermost tag whose start or end name holds <paramref name="offset"/>.</summary>
    public MarkupTag? TagNamedAt(int offset)
    {
        return Tags.Where(tag => tag.NameContains(offset))
            .OrderBy(tag => tag.Element.Length)
            .FirstOrDefault();
    }

    /// <summary>The bound attribute whose name holds <paramref name="offset"/>.</summary>
    public MarkupAttribute? AttributeNamedAt(int offset)
    {
        return Attributes.FirstOrDefault(attribute =>
            attribute.Kind != MarkupAttributeKind.Html
            && attribute.NameSpan is { } name
            && name.Start <= offset
            && offset <= name.End
        );
    }

    /// <summary>The directive whose name holds <paramref name="offset"/>.</summary>
    public MarkupDirective? DirectiveNamedAt(int offset)
    {
        return Directives.FirstOrDefault(directive =>
            directive.NameSpan.Start <= offset && offset <= directive.NameSpan.End
        );
    }
}
