using System.Collections.Immutable;
using Microsoft.AspNetCore.Razor.Language;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>A tag helper directive of a legacy file or of an import: its name and its text.</summary>
internal sealed record TagHelperDirective(string Name, string Text);

/// <summary>
/// The MVC tag helpers a legacy file can use and the prefix their tags carry: what its
/// <c>@addTagHelper</c>, <c>@removeTagHelper</c> and <c>@tagHelperPrefix</c> directives
/// declare, its imports' first, read as the compiler reads them. Implements [RAZOR-MVC-SCOPE].
/// </summary>
internal sealed record RazorTagHelperScope(
    string Prefix,
    ImmutableArray<TagHelperDescriptor> TagHelpers
)
{
    private const string Add = "addTagHelper";
    private const string Remove = "removeTagHelper";
    private const string PrefixDirective = "tagHelperPrefix";
    private const string Global = "global::";

    /// <summary>No tag helpers and no prefix: a component file's scope.</summary>
    public static RazorTagHelperScope Empty { get; } = new("", []);

    /// <summary>The scope <paramref name="directives"/> declare, in order, over <paramref name="all"/>.</summary>
    public static RazorTagHelperScope Of(
        IEnumerable<TagHelperDirective> directives,
        IEnumerable<TagHelperDescriptor> all
    )
    {
        var mvc = all.Where(IsMvc).ToArray();
        return directives.Aggregate(Empty, (scope, directive) => scope.Apply(directive, mvc));
    }

    /// <summary>Whether a directive named <paramref name="name"/> declares the scope.</summary>
    public static bool Declares(string name)
    {
        return name is Add or Remove or PrefixDirective;
    }

    /// <summary>Whether a tag helper is an MVC one, which the directives scope, not a component document's.</summary>
    public static bool IsMvc(TagHelperDescriptor helper)
    {
        return helper.Kind is TagHelperKind.ITagHelper or TagHelperKind.ViewComponent;
    }

    /// <summary>Whether <paramref name="rule"/> targets elements named <paramref name="tagName"/>.</summary>
    public static bool Targets(TagMatchingRuleDescriptor rule, string tagName)
    {
        return rule.TagName is null or "*"
            || string.Equals(
                rule.TagName,
                tagName,
                rule.CaseSensitive ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase
            );
    }

    /// <summary>The tag helpers in scope that target a tag spelled <paramref name="tagName"/>, prefix included.</summary>
    public IEnumerable<TagHelperDescriptor> Targeting(string tagName)
    {
        return tagName.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)
            ? TagHelpers.Where(helper =>
                helper.TagMatchingRules.Any(rule => Targets(rule, tagName[Prefix.Length..]))
            )
            : [];
    }

    private RazorTagHelperScope Apply(TagHelperDirective directive, TagHelperDescriptor[] mvc)
    {
        var text = Unquoted(directive.Text.Trim());
        return directive.Name switch
        {
            Add => this with { TagHelpers = [.. TagHelpers.Union(Matching(text, mvc))] },
            Remove => this with { TagHelpers = [.. TagHelpers.Except(Matching(text, mvc))] },
            PrefixDirective when text.Length > 0 => this with { Prefix = text },
            _ => this,
        };
    }

    /// <summary>A directive's text without the quotes it may be written in.</summary>
    private static string Unquoted(string text)
    {
        return text.Length >= 2 && text[0] == '"' && text[^1] == '"' ? text[1..^1] : text;
    }

    /// <summary>
    /// The tag helpers a <c>TypePattern, AssemblyName</c> lookup names: all of the assembly's
    /// for <c>*</c>, those whose full name starts with what precedes a trailing <c>*</c>, else
    /// the one so named. A lookup the compiler rejects names none.
    /// </summary>
    private static IEnumerable<TagHelperDescriptor> Matching(
        string lookup,
        TagHelperDescriptor[] mvc
    )
    {
        var parts = lookup.Split(',', StringSplitOptions.TrimEntries);
        var valid =
            parts is [{ Length: > 0 }, { Length: > 0 }]
            && !lookup.StartsWith('\'')
            && !lookup.EndsWith('\'');
        var pattern =
            valid && parts[0].StartsWith(Global, StringComparison.Ordinal)
                ? parts[0][Global.Length..]
                : parts[0];
        return valid
            ? mvc.Where(helper => helper.AssemblyName == parts[1] && Matches(pattern, helper.Name))
            : [];
    }

    private static bool Matches(string pattern, string name)
    {
        return pattern == "*"
            || (
                pattern.Length > 1 && pattern[^1] == '*'
                    ? name.StartsWith(pattern[..^1], StringComparison.Ordinal)
                    : name == pattern
            );
    }
}
