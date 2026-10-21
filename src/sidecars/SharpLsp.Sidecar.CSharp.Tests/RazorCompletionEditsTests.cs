using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Additional edits through real SDK projections; [RAZOR-ARCHITECTURE-PROJECTION], [RAZOR-FEATURES-COMPLETION], [RAZOR-TESTING].</summary>
public sealed class RazorCompletionEditsTests(RazorFixture fixture) : IClassFixture<RazorFixture>
{
    private string Board => fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Additional_csharp_edits_map_back_to_the_original_fragment()
    {
        using var manager = await fixture.OpenManagerAsync().ConfigureAwait(true);
        var projection = await manager
            .FindRazorProjectionAsync(Board, default)
            .ConfigureAwait(true);
        Assert.NotNull(projection);
        var declaration = projection
            .GeneratedRoot.DescendantNodes()
            .OfType<VariableDeclaratorSyntax>()
            .Single(node => node.Identifier.ValueText == "caption");
        var edit = Assert.Single(
            RazorCompletionEdits.Map(
                projection,
                [new TextChange(declaration.Identifier.Span, "changed")],
                null
            )
        );
        var (expectedLine, expectedCharacter) = RazorFixture.Locate(
            Board,
            "private string caption",
            "caption"
        );
        Assert.Equal("changed", edit.NewText);
        Assert.Equal(
            (expectedLine, expectedCharacter, expectedLine, expectedCharacter + 7),
            (edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter)
        );
    }

    [Fact]
    public async Task Imports_keep_spelling_and_crlf_after_own_imports_without_duplicates()
    {
        using var manager = await fixture.OpenManagerAsync().ConfigureAwait(true);
        const string text =
            "@using System.Text\r\n@using static System.Math\r\n@using Alias = System.String\r\n<p>body</p>\r\n";
        _ = RazorFixture.Ok(
            await manager.UpdateDocumentTextAsync(Board, text).ConfigureAwait(true)
        );
        var projection = await manager
            .FindRazorProjectionAsync(Board, default)
            .ConfigureAwait(true);
        Assert.NotNull(projection);
        const string added =
            "using System.Text; using System.Linq; using System.Linq; using static System.Math; using Alias = System.String; using NewAlias = System.Uri; using static System.Console;";
        var edits = RazorCompletionEdits
            .Map(projection, [new TextChange(new TextSpan(0, 0), added)], null)
            .ToArray();
        Assert.Equal(
            [
                "@using System.Linq\r\n",
                "@using NewAlias = System.Uri\r\n",
                "@using static System.Console\r\n",
            ],
            edits.Select(edit => edit.NewText)
        );
        Assert.All(
            edits,
            edit =>
                Assert.Equal(
                    (3, 0, 3, 0),
                    (edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter)
                )
        );
        Assert.Equal(3, edits.Length);
    }

    [Fact]
    public async Task Non_using_generated_edits_are_dropped_and_new_imports_use_lf_fallback()
    {
        using var manager = await fixture.OpenManagerAsync().ConfigureAwait(true);
        _ = RazorFixture.Ok(
            await manager.UpdateDocumentTextAsync(Board, "<p>body</p>").ConfigureAwait(true)
        );
        var projection = await manager
            .FindRazorProjectionAsync(Board, default)
            .ConfigureAwait(true);
        Assert.NotNull(projection);
        var invalid = new[] { "class Extra {}", "[assembly: System.Obsolete]", "using ;", "" };
        Assert.All(
            invalid,
            text =>
                Assert.Empty(
                    RazorCompletionEdits.Map(
                        projection,
                        [new TextChange(new TextSpan(0, 0), text)],
                        null
                    )
                )
        );
        var edit = Assert.Single(
            RazorCompletionEdits.Map(
                projection,
                [new TextChange(new TextSpan(0, 0), "using System.Text;")],
                null
            )
        );
        Assert.Equal("@using System.Text\n", edit.NewText);
        Assert.Equal(
            (0, 0, 0, 0),
            (edit.StartLine, edit.StartCharacter, edit.EndLine, edit.EndCharacter)
        );
    }

    [Fact]
    public async Task A_new_import_follows_the_page_directive_a_Razor_Page_opens_with()
    {
        using var manager = await fixture.OpenManagerAsync().ConfigureAwait(true);
        var edit = fixture.Path("PagesApp", "Pages", "Edit.cshtml");
        var projection = await manager.FindRazorProjectionAsync(edit, default).ConfigureAwait(true);
        var markup = await manager.FindRazorMarkupAsync(edit, default).ConfigureAwait(true);
        Assert.NotNull(projection);
        Assert.NotNull(markup);

        // A Razor Page must open with `@page`, so an import goes on the line after it,
        // not at the start the file would otherwise get. [RAZOR-CODE-ACTIONS-USING]
        var added = Assert.Single(
            RazorCompletionEdits.Map(
                projection,
                [new TextChange(new TextSpan(0, 0), "using System.Text;")],
                markup
            )
        );
        Assert.Equal("@using System.Text\n", added.NewText);
        Assert.Equal(
            (1, 0, 1, 0),
            (added.StartLine, added.StartCharacter, added.EndLine, added.EndCharacter)
        );
        var unplaced = Assert.Single(
            RazorCompletionEdits.Map(
                projection,
                [new TextChange(new TextSpan(0, 0), "using System.Text;")],
                null
            )
        );
        Assert.Equal(0, unplaced.StartLine);
    }
}
