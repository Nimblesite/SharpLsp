using SharpLsp.Sidecar.Common;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// C# inside Razor, answered from the projection the SDK's Razor generator produces, against
/// the real fixture solution. Implements [RAZOR-TESTING] for [RAZOR-ARCHITECTURE-PROJECTION],
/// [RAZOR-FEATURES-HOVER], [RAZOR-FEATURES-DEFINITION], [RAZOR-FEATURES-REFERENCES],
/// [RAZOR-FEATURES-SIGNATURE-HELP] and [RAZOR-FEATURES-DIAGNOSTICS].
/// </summary>
public sealed class RazorCSharpFeatureTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorCSharpFeatureTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private static readonly string[] CaptionUses =
    [
        "@bind-Label=",
        "<Badge Text=",
        "<input @bind=",
        "private string caption",
    ];

    private string Board => _fixture.Path("BlazorApp", "Components", "Pages", "Board.razor");

    [Fact]
    public async Task Hover_answers_csharp_fragments_with_ranges_in_the_razor_file()
    {
        using var manager = await _fixture.OpenManagerAsync();

        var caption = RazorFixture.Locate(Board, "<input @bind=", "caption", 2);
        var hover = RazorFixture.Ok(
            await manager.GetHoverAsync(Board, caption.Line, caption.Character)
        );
        Assert.NotNull(hover);
        Assert.Contains("caption", hover.Contents, StringComparison.Ordinal);
        Assert.Contains("string", hover.Contents, StringComparison.Ordinal);
        Assert.Equal(
            (caption.Line, caption.Character - 2),
            (hover.StartLine, hover.StartCharacter)
        );
        Assert.Equal(caption.Character - 2 + "caption".Length, hover.EndCharacter);

        var id = RazorFixture.Locate(Board, "<PageTitle>", "@Id", 1);
        var idHover = RazorFixture.Ok(await manager.GetHoverAsync(Board, id.Line, id.Character));
        Assert.NotNull(idHover);
        Assert.Contains("The board's number", idHover.Contents, StringComparison.Ordinal);
        Assert.Contains("int", idHover.Contents, StringComparison.Ordinal);

        var markup = RazorFixture.Locate(Board, "<button", "disabled");
        Assert.Null(
            RazorFixture.Ok(await manager.GetHoverAsync(Board, markup.Line, markup.Character))
        );
    }

    [Fact]
    public async Task Definition_lands_in_razor_files_from_razor_and_from_csharp()
    {
        using var manager = await _fixture.OpenManagerAsync();

        var call = RazorFixture.Locate(Board, "() => Add(1)", "Add(1)");
        var definition = RazorFixture.Ok(
            await manager.GetDefinitionAsync(Board, call.Line, call.Character)
        );
        var declared = Assert.Single(definition.Locations);
        Assert.True(NativePaths.AreEqual(Board, declared.FilePath), declared.FilePath);
        Assert.Equal(
            RazorFixture.Locate(Board, "private void Add", "Add"),
            (declared.Line, declared.Character)
        );
        Assert.Equal("Add", TextAt(declared));

        var program = _fixture.Path("BlazorApp", "Program.cs");
        var app = RazorFixture.Locate(program, "MapRazorComponents<App>", "App>");
        var component = RazorFixture.Ok(
            await manager.GetDefinitionAsync(program, app.Line, app.Character)
        );
        var file = Assert.Single(component.Locations);
        Assert.True(
            NativePaths.AreEqual(
                _fixture.Path("BlazorApp", "Components", "App.razor"),
                file.FilePath
            ),
            file.FilePath
        );
        Assert.Equal((0, 0), (file.Line, file.Character));
    }

    [Fact]
    public async Task References_and_highlights_cover_every_razor_use_and_drop_scaffolding()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var field = RazorFixture.Locate(Board, "private string caption", "caption");
        var expected = CaptionPositions();

        var references = RazorFixture.Ok(
            await manager.GetReferencesAsync(Board, field.Line, field.Character, true)
        );
        Assert.All(references.Locations, location => Assert.Equal("caption", TextAt(location)));
        Assert.Equal(expected, references.Locations.Select(At).Order());

        var use = expected[1];
        var highlights = RazorFixture.Ok(
            await manager.GetDocumentHighlightsAsync(Board, use.Line, use.Character)
        );
        Assert.Equal(
            expected,
            highlights.Highlights.Select(h => (h.StartLine, h.StartCharacter)).Order()
        );
        Assert.All(
            highlights.Highlights,
            h => Assert.Equal("caption".Length, h.EndCharacter - h.StartCharacter)
        );
    }

    [Fact]
    public async Task Signature_help_answers_inside_a_razor_call()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var argument = RazorFixture.Locate(Board, "() => Add(1)", "1)");

        var help = RazorFixture.Ok(
            await manager.GetSignatureHelpAsync(Board, argument.Line, argument.Character)
        );
        Assert.NotNull(help);
        var signature = Assert.Single(help.Signatures);
        Assert.Contains("Add(int score)", signature.Label, StringComparison.Ordinal);
        Assert.Equal(0, help.ActiveParameter);
    }

    [Fact]
    public async Task Import_files_never_report_their_usings_as_unnecessary()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var imports = _fixture.Path("BlazorApp", "Components", "_Imports.razor");
        var viewImports = _fixture.Path("PagesApp", "Pages", "_ViewImports.cshtml");

        // An import file's usings serve the files beside and below it, which its own
        // projection never sees. [RAZOR-FEATURES-DIAGNOSTICS]
        Assert.DoesNotContain(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(imports)),
            Unnecessary
        );
        Assert.DoesNotContain(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(viewImports)),
            Unnecessary
        );
        var all = RazorFixture.Ok(await manager.GetAllDiagnosticsAsync([]));
        Assert.DoesNotContain(
            all,
            entry => IsImportFile(entry.Key) && entry.Value.Any(Unnecessary)
        );
    }

    [Fact]
    public async Task Components_never_report_a_using_their_markup_may_need_as_unnecessary()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var original = await File.ReadAllTextAsync(Board);
        // `<Virtualize>` resolves through the using, while the generated C# names the
        // component by its full name, so Roslyn alone sees the using as unused.
        // [RAZOR-FEATURES-DIAGNOSTICS]
        const string markup =
            "@using Microsoft.AspNetCore.Components.Web.Virtualization\n"
            + "@using System.Text\n"
            + "<Virtualize TItem=\"string\" ItemsProvider=\"null\" />\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, markup + original));

        var diagnostics = RazorFixture.Ok(await manager.GetDiagnosticsAsync(Board));
        Assert.DoesNotContain(diagnostics, Unnecessary);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Severity == "Error");
        var all = RazorFixture.Ok(await manager.GetAllDiagnosticsAsync([]));
        Assert.DoesNotContain(
            all,
            entry => NativePaths.AreEqual(entry.Key, Board) && entry.Value.Any(Unnecessary)
        );
        // The tag binds through that using, so removing it would unbind the component.
        var facts = await manager.FindRazorMarkupAsync(Board, default);
        Assert.NotNull(facts);
        var virtualize = Assert.Single(facts.Tags, tag => tag.Name == "Virtualize");
        Assert.Equal(
            "Microsoft.AspNetCore.Components.Web.Virtualization",
            virtualize.Component?.TypeNamespace
        );

        // A C# file, code-behind included, still reports an unused using.
        var badge = _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor.cs");
        var code = await File.ReadAllTextAsync(badge);
        _ = RazorFixture.Ok(
            await manager.UpdateDocumentTextAsync(badge, "using System.Text;\n" + code)
        );
        var unused = Assert.Single(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(badge)),
            Unnecessary
        );
        Assert.Equal((0, 0), (unused.StartLine, unused.StartCharacter));
    }

    private static bool Unnecessary(DiagnosticResult diagnostic)
    {
        return diagnostic.Code is "CS8019" or "IDE0005";
    }

    private static bool IsImportFile(string path)
    {
        return NativePaths.SameName(path, "_Imports.razor")
            || NativePaths.SameName(path, "_ViewImports.cshtml");
    }

    [Fact]
    public async Task Diagnostics_map_csharp_errors_into_the_razor_file_and_the_solution_scan()
    {
        using var manager = await _fixture.OpenManagerAsync();
        Assert.DoesNotContain(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(Board)),
            diagnostic => diagnostic.Severity == "Error"
        );

        var original = await File.ReadAllTextAsync(Board);
        var broken = original.Replace("score + Id)", "score + Idd)", StringComparison.Ordinal);
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Board, broken));

        var error = Assert.Single(
            RazorFixture.Ok(await manager.GetDiagnosticsAsync(Board)),
            d => d.Code == "CS0103"
        );
        Assert.True(NativePaths.AreEqual(Board, error.FilePath), error.FilePath);
        Assert.Equal(
            RazorFixture.Locate(Board, "private void Add", "Id)"),
            (error.StartLine, error.StartCharacter)
        );
        Assert.Equal(error.StartCharacter + "Idd".Length, error.EndCharacter);

        var all = RazorFixture.Ok(await manager.GetAllDiagnosticsAsync([]));
        var key = Assert.Single(all.Keys, path => NativePaths.AreEqual(path, Board));
        Assert.Contains(all[key], d => d.Code == "CS0103" && d.StartLine == error.StartLine);
        Assert.DoesNotContain(all.Keys, path => NativePaths.HasExtension(path, ".g.cs"));
    }

    [Fact]
    public async Task Completion_in_an_expression_offers_members_with_edits_in_the_razor_file()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var counter = _fixture.Path("BlazorApp", "Components", "Pages", "Counter.razor");
        var typed = RazorFixture.Locate(counter, "Current count:", "currentCount", 4);

        var items = RazorFixture.Ok(
            await manager.GetCompletionsAsync(counter, typed.Line, typed.Character)
        );
        var field = Assert.Single(items, item => item.Label == "currentCount");
        Assert.NotNull(field.TextEdit);
        Assert.Equal(
            (typed.Line, typed.Character - 4),
            (field.TextEdit.StartLine, field.TextEdit.StartCharacter)
        );
        Assert.Equal(typed.Character - 4 + "currentCount".Length, field.TextEdit.EndCharacter);
        Assert.Contains(items, item => item.Label == "IncrementCount");
        Assert.All(items, item => Assert.Equal(typed.Line, item.TextEdit?.StartLine ?? typed.Line));
    }

    [Fact]
    public async Task Rename_of_a_code_block_field_edits_every_razor_use_and_prepares_its_range()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var use = RazorFixture.Locate(Board, "<Badge Text=", "caption");

        var prepared = RazorFixture.Ok(
            await manager.PrepareRenameAsync(Board, use.Line, use.Character)
        );
        Assert.True(prepared.CanRename);
        Assert.Equal("caption", prepared.Placeholder);
        Assert.Equal(
            (use.Line, use.Character, use.Character + 7),
            (prepared.StartLine, prepared.StartCharacter, prepared.EndCharacter)
        );

        var edit = RazorFixture.Ok(
            await manager.RenameAsync(Board, use.Line, use.Character, "heading")
        );
        var document = Assert.Single(edit.DocumentChanges);
        Assert.True(NativePaths.AreEqual(Board, document.FilePath), document.FilePath);
        Assert.Equal(4, document.Edits.Count);
        Assert.All(document.Edits, e => Assert.Equal("heading", e.NewText));
        Assert.Equal(
            CaptionPositions(),
            document.Edits.Select(e => (e.StartLine, e.StartCharacter))
        );

        var markup = RazorFixture.Locate(Board, "<button", "disabled");
        Assert.False(
            RazorFixture
                .Ok(await manager.PrepareRenameAsync(Board, markup.Line, markup.Character))
                .CanRename
        );
    }

    [Fact]
    public async Task Semantic_tokens_classify_csharp_fragments_at_their_razor_positions()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var tokens = Decode(RazorFixture.Ok(await manager.GetSemanticTokensFullAsync(Board)).Data);

        Assert.Contains(
            tokens,
            t => t == (RazorFixture.Locate(Board, "private readonly List", "private"), 7, 15)
        );
        Assert.Contains(
            tokens,
            t => t == (RazorFixture.Locate(Board, "private readonly List", "List"), 4, 2)
        );
        Assert.Contains(
            tokens,
            t => t == (RazorFixture.Locate(Board, "private void Add", "Add"), 3, 13)
        );
        Assert.Contains(tokens, t => t == (RazorFixture.Locate(Board, "<PageTitle>", "Id"), 2, 9));
        Assert.DoesNotContain(
            tokens,
            t => t.At.Line == RazorFixture.Locate(Board, "</Panel>", "Panel").Line
        );

        var code = RazorFixture.Locate(Board, "private void Add", "private");
        var range = Decode(
            RazorFixture
                .Ok(
                    await manager.GetSemanticTokensRangeAsync(Board, code.Line, 0, code.Line + 1, 0)
                )
                .Data
        );
        Assert.NotEmpty(range);
        Assert.All(range, t => Assert.Equal(code.Line, t.At.Line));
    }

    /// <summary>LSP semantic token data as absolute (position, length, type) triples.</summary>
    private static List<((int Line, int Character) At, int Length, int Type)> Decode(int[] data)
    {
        var tokens = new List<((int, int), int, int)>();
        var (line, character) = (0, 0);
        for (var i = 0; i + 4 < data.Length; i += 5)
        {
            line += data[i];
            character = data[i] == 0 ? character + data[i + 1] : data[i + 1];
            tokens.Add(((line, character), data[i + 2], data[i + 3]));
        }

        return tokens;
    }

    /// <summary>Every place Board.razor names its <c>caption</c> field, in file order.</summary>
    private (int Line, int Character)[] CaptionPositions()
    {
        return [.. CaptionUses.Select(anchor => RazorFixture.Locate(Board, anchor, "caption"))];
    }

    private static string TextAt(LocationResult location)
    {
        var line = File.ReadAllLines(location.FilePath)[location.Line];
        return line[location.Character..location.EndCharacter];
    }

    private static (int Line, int Character) At(LocationResult location)
    {
        return (location.Line, location.Character);
    }
}
