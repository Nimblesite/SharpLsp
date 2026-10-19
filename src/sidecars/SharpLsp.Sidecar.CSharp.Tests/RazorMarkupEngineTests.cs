using Microsoft.AspNetCore.Razor.Language;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// The bundled engine's markup facts for the fixture's real files. Implements [RAZOR-TESTING]
/// for [RAZOR-ARCHITECTURE-ENGINE].
/// </summary>
public sealed class RazorMarkupEngineTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorMarkupEngineTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Components_from_the_app_and_its_class_library_bind_with_name_spans()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);
        Assert.Equal(RazorFileKind.Component, markup.FileKind);
        Assert.Equal("BlazorApp.Components.Pages", markup.Namespace);
        Assert.Contains("BlazorApp.Components.Shared", markup.ImportedNamespaces);
        Assert.Contains("Widgets", markup.ImportedNamespaces);

        var panel = Assert.Single(markup.Tags, tag => tag.Name == "Panel");
        Assert.Equal("Widgets.Panel", panel.Component?.TypeName);
        Assert.Equal("Panel", Slice(markup, panel.StartName));
        Assert.Equal("Panel", Slice(markup, panel.EndName!.Value));
        Assert.Equal(
            RazorFixture.Locate(Board, "</Panel>", "Panel").Line,
            Line(markup, panel.EndName.Value)
        );

        var tally = Assert.Single(markup.Tags, tag => tag.Name == "Tally");
        Assert.Equal("BlazorApp.Components.Shared.Tally<TItem>", tally.Component?.TypeName);
        var badge = Assert.Single(markup.Tags, tag => tag.Name == "Badge");
        Assert.Null(badge.EndName);
        Assert.Equal("Badge", Slice(markup, badge.StartName));
    }

    [Fact]
    public async Task Attributes_directives_and_their_parameters_carry_their_descriptors()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);

        var title = Assert.Single(markup.Attributes, a => a.Name == "Title");
        Assert.Equal(MarkupAttributeKind.Property, title.Kind);
        Assert.Equal("Title", title.Bound?.PropertyName);
        Assert.Equal("Title", Slice(markup, title.NameSpan!.Value));

        var bind = Assert.Single(
            markup.Attributes,
            a =>
                a.Name == "@bind-Label"
                && a.TagHelper?.Kind == TagHelperKind.Bind
                && a.Owner.Name == "Tally"
                && a.TagHelper.Name != "Bind"
        );
        Assert.Equal("@bind-Label", Slice(markup, bind.NameSpan!.Value));

        var parameter = Assert.Single(
            markup.Attributes,
            a => a.Kind == MarkupAttributeKind.DirectiveParameter
        );
        Assert.Equal("@bind:event", parameter.Name);
        Assert.Equal("event", parameter.Parameter?.Name);
        Assert.Equal("input", parameter.Owner.Name);

        var click = Assert.Single(markup.Attributes, a => a.Name == "@onclick");
        Assert.Equal(TagHelperKind.EventHandler, click.TagHelper?.Kind);
        Assert.Equal("@onclick", Slice(markup, click.NameSpan!.Value));
        Assert.Contains(
            markup.Attributes,
            a => a.Name == "disabled" && a.Kind == MarkupAttributeKind.Html
        );
    }

    [Fact]
    public async Task Directives_and_razor_diagnostics_come_from_the_compiler()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);
        Assert.Equal(
            ["page", "implements", "inject", "code"],
            markup.Directives.Where(d => d.Name != "using").Select(d => d.Name)
        );
        Assert.All(markup.Directives, d => Assert.Equal(d.Name, Slice(markup, d.NameSpan)));
        Assert.Contains(markup.AvailableDirectives, d => d.Directive == "rendermode");
        Assert.Empty(markup.Diagnostics);

        var text = await File.ReadAllTextAsync(Board);
        var broken = text.Replace("<Badge Text", "<Bdage Text", StringComparison.Ordinal);
        _ = await manager.UpdateDocumentTextAsync(Board, broken);
        var edited = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(edited);
        var unknown = Assert.Single(edited.Diagnostics, d => d.Id == "RZ10012");
        Assert.Equal(RazorDiagnosticSeverity.Warning, unknown.Severity);
        Assert.Contains("Bdage", unknown.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(edited.Tags, tag => tag.Name == "Badge");
    }

    [Fact]
    public async Task Names_at_an_offset_find_their_tag_attribute_and_directive()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var markup = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(markup);

        var title = Offset(markup, RazorFixture.Locate(Board, "<Panel", "Title", 2));
        Assert.Equal("Title", markup.AttributeNamedAt(title)?.Name);
        var click = Offset(markup, RazorFixture.Locate(Board, "<button", "@onclick", 1));
        Assert.Equal("@onclick", markup.AttributeNamedAt(click)?.Name);
        var inject = Offset(markup, RazorFixture.Locate(Board, "@inject", "inject", 3));
        Assert.Equal("inject", markup.DirectiveNamedAt(inject)?.Name);
        var end = Offset(markup, RazorFixture.Locate(Board, "</Panel>", "Panel", 1));
        Assert.Equal("Panel", markup.TagNamedAt(end)?.Name);

        // HTML attributes belong to the HTML server, and content names nothing.
        var disabled = Offset(markup, RazorFixture.Locate(Board, "<button", "disabled", 1));
        Assert.Null(markup.AttributeNamedAt(disabled));
        var content = Offset(markup, RazorFixture.Locate(Board, "<button", ">Add<", 2));
        Assert.Null(markup.AttributeNamedAt(content));
        Assert.Null(markup.DirectiveNamedAt(content));
        Assert.Null(markup.TagNamedAt(content));
    }

    private static int Offset(RazorMarkup markup, (int Line, int Character) at)
    {
        return markup.Text.Lines.GetPosition(
            new Microsoft.CodeAnalysis.Text.LinePosition(at.Line, at.Character)
        );
    }

    private static string Slice(RazorMarkup markup, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        return markup.Text.ToString(span);
    }

    private static int Line(RazorMarkup markup, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        return markup.Text.Lines.GetLineFromPosition(span.Start).LineNumber;
    }
}
