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

    private static string Slice(RazorMarkup markup, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        return markup.Text.ToString(span);
    }

    private static int Line(RazorMarkup markup, Microsoft.CodeAnalysis.Text.TextSpan span)
    {
        return markup.Text.Lines.GetLineFromPosition(span.Start).LineNumber;
    }
}
