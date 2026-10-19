using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.CSharp.Razor;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The C# symbols behind the fixture's markup: the types its components instantiate and the
/// properties its attributes set. Implements [RAZOR-TESTING] for [RAZOR-FEATURES-HOVER] and
/// [RAZOR-FEATURES-DEFINITION].
/// </summary>
public sealed class RazorMarkupSymbolsTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupSymbolsTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Component_tags_resolve_to_their_types_from_the_app_and_its_library()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (markup, compilation) = await ReadAsync(manager, Board);

        var panel = RazorMarkupSymbols.TypeOf(compilation, Tag(markup, "Panel"));
        Assert.Equal("Widgets.Panel", panel?.ToDisplayString());
        Assert.Equal("Widgets", panel?.ContainingAssembly.Name);
        var tally = RazorMarkupSymbols.TypeOf(compilation, Tag(markup, "Tally"));
        Assert.Equal("BlazorApp.Components.Shared.Tally<TItem>", tally?.ToDisplayString());
        Assert.Equal(1, tally?.Arity);
        Assert.Null(RazorMarkupSymbols.TypeOf(compilation, Tag(markup, "input")));
        Assert.Null(RazorMarkupSymbols.TypeOf(compilation, Tag(markup, "button")));

        var inherited = RazorMarkupSymbols.PropertyOf(panel!, "RendererInfo");
        Assert.Equal("ComponentBase", inherited?.ContainingType.Name);
        Assert.Null(RazorMarkupSymbols.PropertyOf(panel!, "Missing"));
    }

    [Fact]
    public async Task Parameters_and_bind_X_set_properties_and_other_attributes_set_none()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (markup, compilation) = await ReadAsync(manager, Board);

        var title = RazorMarkupSymbols.PropertyOf(compilation, Attribute(markup, "Title"));
        Assert.Equal("Widgets.Panel.Title", title?.ToDisplayString());
        var items = RazorMarkupSymbols.PropertyOf(compilation, Attribute(markup, "Items"));
        Assert.Equal(("Items", "Tally"), (items?.Name, items?.ContainingType.Name));

        // `@bind-Label` binds through Tally's own bind helper and the generic `@bind`
        // helper; only Tally's sets a property, its Label parameter.
        var binds = markup.Attributes.Where(a => a.Name == "@bind-Label").ToList();
        Assert.True(binds.Count > 1, "both bind helpers see @bind-Label");
        var bound = binds
            .Select(a => RazorMarkupSymbols.PropertyOf(compilation, a))
            .OfType<IPropertySymbol>();
        var label = Assert.Single(bound);
        Assert.Equal(("Label", "Tally"), (label.Name, label.ContainingType.Name));

        Assert.Null(RazorMarkupSymbols.PropertyOf(compilation, Attribute(markup, "@onclick")));
        Assert.Null(RazorMarkupSymbols.PropertyOf(compilation, Attribute(markup, "disabled")));
        Assert.All(
            markup.Attributes.Where(a => a.Owner.Name == "input"),
            attribute => Assert.Null(RazorMarkupSymbols.PropertyOf(compilation, attribute))
        );
    }

    [Fact]
    public async Task A_child_content_tag_sets_the_parameter_of_its_enclosing_component()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Board);
        var edited = text.Replace(
            "<PageTitle>Board @Id</PageTitle>",
            "<PageTitle>Board @Id</PageTitle>\n<Panel Title=\"Notes\"><ChildContent>Kept</ChildContent></Panel>",
            StringComparison.Ordinal
        );
        _ = await manager.UpdateDocumentTextAsync(Board, edited);
        var (markup, compilation) = await ReadAsync(manager, Board);

        var content = Tag(markup, "ChildContent");
        Assert.NotNull(content.ChildContent);
        var property = RazorMarkupSymbols.ChildContentOf(compilation, markup, content);
        Assert.Equal("Widgets.Panel.ChildContent", property?.ToDisplayString());
        // Badge's nearest enclosing component is Tally, which has no Badge parameter.
        Assert.Null(RazorMarkupSymbols.ChildContentOf(compilation, markup, Tag(markup, "Badge")));
    }

    private static async Task<(RazorMarkup Markup, Compilation Compilation)> ReadAsync(
        WorkspaceManager manager,
        string path
    )
    {
        var markup = await manager.FindRazorMarkupAsync(path, default);
        var project = manager.FindRazorDocument(path)?.Project;
        var compilation = project is null ? null : await project.GetCompilationAsync();
        Assert.NotNull(markup);
        Assert.NotNull(compilation);
        return (markup, compilation);
    }

    private static MarkupTag Tag(RazorMarkup markup, string name)
    {
        return Assert.Single(markup.Tags, tag => tag.Name == name);
    }

    private static MarkupAttribute Attribute(RazorMarkup markup, string name)
    {
        return Assert.Single(markup.Attributes, attribute => attribute.Name == name);
    }
}
