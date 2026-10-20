using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// The C# symbols behind markup: the type a component or tag helper descriptor names, and
/// the property a bound attribute sets. Implements [RAZOR-FEATURES-HOVER] and
/// [RAZOR-FEATURES-DEFINITION].
/// </summary>
internal static class RazorMarkupSymbols
{
    /// <summary>The type <paramref name="descriptor"/> names in <paramref name="compilation"/>.</summary>
    public static INamedTypeSymbol? TypeOf(Compilation compilation, TagHelperDescriptor descriptor)
    {
        // A generic component's type name ends in its type parameters: `Shared.Tally<TItem>`.
        // A name's arity counts only its own, so a qualified name asks its rightmost part.
        var name = SyntaxFactory.ParseName(descriptor.TypeName);
        var arity = (name is QualifiedNameSyntax qualified ? qualified.Right : name).Arity;
        var prefix = string.IsNullOrEmpty(descriptor.TypeNamespace)
            ? ""
            : descriptor.TypeNamespace + ".";
        var suffix = arity > 0 ? "`" + arity : "";
        return compilation.GetTypeByMetadataName(prefix + descriptor.TypeNameIdentifier + suffix);
    }

    /// <summary>The property named <paramref name="name"/> on <paramref name="type"/> or a base type.</summary>
    public static IPropertySymbol? PropertyOf(INamedTypeSymbol type, string name)
    {
        for (var current = type; current is not null; current = current.BaseType)
        {
            if (current.GetMembers(name).OfType<IPropertySymbol>().FirstOrDefault() is { } found)
            {
                return found;
            }
        }

        return null;
    }

    /// <summary>
    /// The C# symbol the markup name at <paramref name="offset"/> names, with that name's span:
    /// a tag's component type or the child-content parameter it sets, an attribute's property.
    /// </summary>
    public static (ISymbol Symbol, TextSpan Name)? At(
        Compilation compilation,
        RazorMarkup markup,
        int offset
    )
    {
        if (markup.TagNamedAt(offset) is { } tag && TagSymbol(compilation, markup, tag) is { } type)
        {
            return (type, tag.NameAt(offset));
        }

        return
            markup.AttributeNamedAt(offset) is { NameSpan: { } name } attribute
            && PropertyOf(compilation, attribute) is { } property
            ? (property, name)
            : null;
    }

    private static ISymbol? TagSymbol(Compilation compilation, RazorMarkup markup, MarkupTag tag)
    {
        return TypeOf(compilation, tag)
            ?? (
                tag.ChildContent is null ? null : (ISymbol?)ChildContentOf(compilation, markup, tag)
            );
    }

    /// <summary>The type a tag instantiates: its component, else its first MVC tag helper.</summary>
    public static INamedTypeSymbol? TypeOf(Compilation compilation, MarkupTag tag)
    {
        var descriptor = tag.Component ?? tag.MvcTagHelpers.FirstOrDefault();
        return descriptor is null ? null : TypeOf(compilation, descriptor);
    }

    /// <summary>
    /// The property an attribute sets: a component parameter, a tag helper property, or the
    /// parameter a <c>@bind-X</c> binds. Directive attributes such as <c>@onclick</c> set none.
    /// </summary>
    public static IPropertySymbol? PropertyOf(Compilation compilation, MarkupAttribute attribute)
    {
        var type = attribute.TagHelper is { } helper ? TypeOf(compilation, helper) : null;
        return type is null || BoundProperty(attribute) is not { } name
            ? null
            : PropertyOf(type, name);
    }

    /// <summary>The parameter a <c>&lt;ChildContent&gt;</c>-style tag sets on its enclosing component.</summary>
    public static IPropertySymbol? ChildContentOf(
        Compilation compilation,
        RazorMarkup markup,
        MarkupTag tag
    )
    {
        var parent = markup
            .Tags.Where(candidate =>
                candidate.Component is not null
                && candidate.Element.Contains(tag.Element)
                && candidate.Element != tag.Element
            )
            .OrderBy(candidate => candidate.Element.Length)
            .FirstOrDefault();
        var type = parent is null ? null : TypeOf(compilation, parent);
        return type is null ? null : PropertyOf(type, tag.Name);
    }

    private static string? BoundProperty(MarkupAttribute attribute)
    {
        var binds =
            attribute.Kind == MarkupAttributeKind.Property
            || (
                attribute.Kind == MarkupAttributeKind.Directive
                && attribute.TagHelper is { Kind: TagHelperKind.Bind } helper
                && helper.Name != "Bind"
            );
        return binds ? attribute.Bound?.PropertyName : null;
    }
}
