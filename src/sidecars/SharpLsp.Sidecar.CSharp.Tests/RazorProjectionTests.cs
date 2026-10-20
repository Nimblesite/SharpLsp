using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A Razor file's C# projection, read from generated sources written the way the SDK's Razor
/// generator writes them: a <c>#pragma checksum</c> names the Razor file, and <c>#line</c>
/// spans map each C# fragment back into it. Hidden lines, line numbers without a file,
/// other files and spans outside the Razor text never map. Implements [RAZOR-TESTING] for
/// [RAZOR-ARCHITECTURE-PROJECTION] and [RAZOR-FEATURES-RENAME].
/// </summary>
public sealed class RazorProjectionTests
{
    // `count` is used on line 0 at 4..9 and declared on line 2 at 15..20.
    private const string CounterText = "<p>@count</p>\n@code {\n    public int count = 1;\n}\n";

    private static readonly string Counter = AdhocRazorProject.PathOf("Counter.razor");
    private static readonly string Stale = AdhocRazorProject.PathOf("Stale.razor");
    private static readonly string Orphan = AdhocRazorProject.PathOf("Orphan.razor");
    private static readonly string Notes = AdhocRazorProject.PathOf("Notes.txt");
    private static readonly string Ghost = AdhocRazorProject.PathOf("Ghost.razor");

    [Fact]
    public async Task A_razor_file_projects_through_the_generated_document_its_checksum_names()
    {
        using var workspace = new AdhocWorkspace();
        var razor = AdhocRazorProject.Additional(Create(workspace), Counter);

        var projection = await RazorProjection.ForRazorAsync(razor, default);

        Assert.NotNull(projection);
        Assert.Equal(Counter, projection.RazorPath);
        Assert.Equal("Counter.g.cs", projection.Generated.HintName);
        Assert.Equal(CounterText, projection.RazorText.ToString());
        Assert.Equal(CounterSource(), projection.GeneratedText.ToString());
        // The use, the declaration and the closing brace map, in Razor order. Roslyn puts a
        // mapped end one past the fragment, so an entry runs on through a line break both
        // texts share, and the brace's end, past the Razor text, stops at the text's end.
        Assert.Equal(
            [(4, "count"), (26, "public int count = 1;\n"), (48, "}\n")],
            projection.Map.Mappings.Select(entry =>
                (entry.RazorStart, projection.RazorText.ToString(Razor(entry)))
            )
        );
        Assert.All(
            projection.Map.Mappings,
            entry =>
                Assert.Equal(
                    projection.RazorText.ToString(Razor(entry)),
                    projection.GeneratedText.ToString(Generated(entry))
                )
        );
    }

    [Fact]
    public async Task Positions_map_inside_and_at_the_end_of_a_fragment_and_nowhere_else()
    {
        using var workspace = new AdhocWorkspace();
        var razor = AdhocRazorProject.Additional(Create(workspace), Counter);
        var projection = await RazorProjection.ForRazorAsync(razor, default);
        Assert.NotNull(projection);
        var use = UseLine(projection.GeneratedText);

        Assert.Equal(new LinePosition(use, 0), projection.ToGenerated(new LinePosition(0, 4)));
        Assert.Equal(new LinePosition(use, 2), projection.ToGenerated(new LinePosition(0, 6)));
        // A caret just after `@count` still maps, to the end of the generated fragment.
        Assert.Equal(new LinePosition(use, 5), projection.ToGenerated(new LinePosition(0, 9)));
        Assert.Null(projection.ToGenerated(new LinePosition(0, 1)));
        Assert.Null(projection.ToGenerated(new LinePosition(1, 3)));
        Assert.Null(projection.ToGenerated(new LinePosition(9, 0)));

        Assert.Equal(Span(0, 4, 0, 9), projection.ToRazor(Span(use, 0, use, 5)));
        Assert.Equal(Span(0, 5, 0, 7), projection.ToRazor(Span(use, 1, use, 3)));
        Assert.Null(projection.ToRazor(Span(use, 0, use + 1, 0)));
        Assert.Null(projection.ToRazor(Span(0, 0, 0, 3)));
        Assert.Null(projection.ToRazor(Span(use, 0, 999, 0)));
    }

    [Fact]
    public async Task Only_a_listed_razor_file_that_a_checksum_names_has_a_projection()
    {
        using var workspace = new AdhocWorkspace();
        var project = Create(workspace);
        var generated = (await project.GetSourceGeneratedDocumentsAsync()).ToDictionary(document =>
            document.HintName
        );

        Assert.Null(await RazorProjection.ForRazorAsync(Additional(project, Orphan), default));
        Assert.Equal(Counter, (await ForGenerated(generated["Counter.g.cs"]))?.RazorPath);
        Assert.Equal(Stale, (await ForGenerated(generated["Stale.g.cs"]))?.RazorPath);
        // Ghost.razor is not in the project, Notes.txt is not Razor, and Plain names no file.
        Assert.Null(await ForGenerated(generated["Ghost.g.cs"]));
        Assert.Null(await ForGenerated(generated["Notes.g.cs"]));
        Assert.Null(await ForGenerated(generated["Plain.g.cs"]));

        Assert.Equal(Notes, RazorProjection.ChecksumPath(await Root(generated["Notes.g.cs"])));
        Assert.Null(RazorProjection.ChecksumPath(await Root(generated["Plain.g.cs"])));
        Assert.Null(RazorProjection.ChecksumPath(null));
    }

    [Fact]
    public async Task A_project_whose_generators_add_nothing_projects_no_razor_file()
    {
        using var workspace = new AdhocWorkspace();
        var project = AdhocRazorProject.Create(workspace, [(Orphan, "<p>orphan</p>\n")]);

        var projection = await RazorProjection.ForRazorAsync(Additional(project, Orphan), default);

        Assert.Null(projection);
        Assert.Empty(await project.GetSourceGeneratedDocumentsAsync());
        _ = Assert.Single(project.AdditionalDocuments);
    }

    [Fact]
    public async Task Rename_edits_only_listed_razor_spans_that_hold_the_old_name()
    {
        using var workspace = new AdhocWorkspace();
        var project = Create(workspace);
        var compilation = await project.GetCompilationAsync();
        var field = compilation!.GetTypeByMetadataName("App.Counter")!.GetMembers("count").Single();
        var referenced = await SymbolFinder.FindReferencesAsync(field, project.Solution);

        var edits = await RazorRenameEdits.FromReferencesAsync(
            project.Solution,
            referenced,
            ("count", "total"),
            default
        );

        // Ghost.razor is unlisted, Stale.razor's span holds `total`, and the hidden, unmapped,
        // foreign and out-of-range uses map to no Razor text.
        var edit = Assert.Single(edits);
        Assert.Equal(Counter, edit.FilePath);
        Assert.Equal(
            [(0, 4, 0, 9), (2, 15, 2, 20)],
            edit.Edits.Select(e => (e.StartLine, e.StartCharacter, e.EndLine, e.EndCharacter))
        );
        Assert.All(edit.Edits, e => Assert.Equal("total", e.NewText));
        var found = await RazorRenameEdits.FindAsync(project.Solution, field, "total", default);
        Assert.Equal(
            edit.Edits.Select(e => (e.StartLine, e.StartCharacter)),
            Assert.Single(found).Edits.Select(e => (e.StartLine, e.StartCharacter))
        );
    }

    [Fact]
    public void Mappings_that_start_outside_either_text_are_dropped()
    {
        var tree = CSharpSyntaxTree.ParseText(CounterSource());
        var generated = tree.GetText();
        var razor = SourceText.From(CounterText);
        var use = UseLine(generated);
        // The generated text ends just before the use's line, as a stale snapshot would.
        var cut = SourceText.From(
            generated.ToString(TextSpan.FromBounds(0, generated.Lines[use - 1].End))
        );

        Assert.Equal([4, 26, 48], Starts(RazorSpanMap.Build(tree, generated, razor, Counter)));
        Assert.Equal([26], Starts(RazorSpanMap.Build(tree, cut, razor, Counter)));
        Assert.Equal(
            [4],
            Starts(RazorSpanMap.Build(tree, generated, SourceText.From("<p>@count</p>\n"), Counter))
        );
        Assert.Empty(RazorSpanMap.Build(tree, generated, razor, Stale).Mappings);
    }

    [Theory]
    [InlineData(")", false)]
    [InlineData("))", false)]
    [InlineData("]})", false)]
    [InlineData("))", true)]
    public void Completion_carets_stay_before_inserted_closers_and_later_fragments_still_map(
        string closing,
        bool earlierInsertion
    )
    {
        // A temporary completion copy can map a whole fragment containing its synthetic
        // closers. Only the prefix belongs to the user's expression; a surviving suffix
        // would claim the caret after the closers. [RAZOR-FEATURES-COMPLETION]
        var shift = earlierInsertion ? 1 : 0;
        var close = new TextChange(new TextSpan(8, 0), closing);
        var copy = new RazorSpanMap([
            new(4 + shift, 100, 12 + closing.Length),
            new(8 + shift, 150, closing.Length),
            new(22 + shift + closing.Length, 200, 5),
        ]);
        var map = copy.Without(
            earlierInsertion ? [new TextChange(new TextSpan(2, 0), "("), close] : [close]
        );
        Assert.Equal<RazorMapping>([new(4, 100, 4), new(22, 200, 5)], map.Mappings);
        Assert.Equal(100, map.ToGenerated(4));
        Assert.Equal(104, map.ToGenerated(8));
        Assert.Null(map.ToGenerated(9));
        Assert.Null(map.ToGenerated(3));
        Assert.Equal(new TextSpan(4, 4), map.ToRazor(new TextSpan(100, 4)));
        Assert.Null(map.ToRazor(new TextSpan(104, 1)));
        Assert.Null(map.ToRazor(new TextSpan(150, closing.Length)));
        Assert.Equal(200, map.ToGenerated(22));
        Assert.Equal(205, map.ToGenerated(27));
        Assert.Equal(new TextSpan(22, 5), map.ToRazor(new TextSpan(200, 5)));
        Assert.Equal<RazorMapping>(map.Mappings, map.Without([]).Mappings);
    }

    private static Project Create(AdhocWorkspace workspace)
    {
        return AdhocRazorProject.Create(
            workspace,
            [
                (Counter, CounterText),
                (Stale, "<p>@total</p>\n"),
                (Orphan, "<p>orphan</p>\n"),
                (Notes, "notes\n"),
            ],
            generated:
            [
                ("Counter.g.cs", CounterSource()),
                ("Stale.g.cs", ReaderSource("Stale", Stale)),
                ("Ghost.g.cs", ReaderSource("Ghost", Ghost)),
                ("Notes.g.cs", Lines(Checksum(Notes), "namespace App { partial class Notes { } }")),
                ("Plain.g.cs", "namespace App { partial class Plain { } }"),
            ]
        );
    }

    /// <summary>Counter's projection: every kind of line mapping the generator can write.</summary>
    private static string CounterSource()
    {
        return Lines(
            Checksum(Counter),
            "namespace App",
            "{",
            "    public partial class Counter",
            "    {",
            $"#line (3,5)-(3,26) \"{Counter}\"",
            "public int count = 1;",
            "#line default",
            "        public object Render()",
            "        {",
            "            return",
            $"#line (1,5)-(1,10) \"{Counter}\"",
            "count",
            "#line default",
            "            ;",
            "        }",
            "#line hidden",
            "        public int Hidden => count;",
            "#line default",
            "#line 7",
            "        public int Unmapped => count;",
            $"#line 9 \"{AdhocRazorProject.PathOf("Other.cs")}\"",
            "        public int Elsewhere => count;",
            $"#line (40,1)-(40,6) \"{Counter}\"",
            "public int Far => count;",
            $"#line (1,40)-(1,45) \"{Counter}\"",
            "public int Wide => count;",
            "#line default",
            "        public void Block()",
            "        {",
            "            {",
            $"#line (4,1)-(9,1) \"{Counter}\"",
            "}",
            "#line default",
            "        }",
            "    }",
            "}"
        );
    }

    /// <summary>A projection of <paramref name="razorPath"/> that reads Counter's field there.</summary>
    private static string ReaderSource(string name, string razorPath)
    {
        return Lines(
            Checksum(razorPath),
            "namespace App",
            "{",
            $"    public partial class {name}",
            "    {",
            "        public int Read(Counter counter)",
            "        {",
            "            return counter.",
            $"#line (1,5)-(1,10) \"{razorPath}\"",
            "count",
            "#line default",
            "            ;",
            "        }",
            "    }",
            "}"
        );
    }

    private static string Checksum(string path)
    {
        return $"#pragma checksum \"{path}\" \"{{8829d00f-11b8-4213-878b-770e8597ac16}}\" \"00\"";
    }

    private static string Lines(params string[] lines)
    {
        return string.Join("\n", lines);
    }

    /// <summary>The generated line that holds Counter's mapped use of <c>count</c>.</summary>
    private static int UseLine(SourceText generated)
    {
        return generated.Lines.Single(line => line.ToString() == "count").LineNumber;
    }

    private static TextDocument Additional(Project project, string path)
    {
        return AdhocRazorProject.Additional(project, path);
    }

    private static Task<RazorProjection?> ForGenerated(SourceGeneratedDocument generated)
    {
        return RazorProjection.ForGeneratedAsync(generated, default);
    }

    private static Task<SyntaxNode?> Root(SourceGeneratedDocument generated)
    {
        return generated.GetSyntaxRootAsync();
    }

    private static int[] Starts(RazorSpanMap map)
    {
        return [.. map.Mappings.Select(entry => entry.RazorStart)];
    }

    private static TextSpan Razor(RazorMapping entry)
    {
        return new TextSpan(entry.RazorStart, entry.Length);
    }

    private static TextSpan Generated(RazorMapping entry)
    {
        return new TextSpan(entry.GeneratedStart, entry.Length);
    }

    private static LinePositionSpan Span(int line, int character, int endLine, int endCharacter)
    {
        return new LinePositionSpan(
            new LinePosition(line, character),
            new LinePosition(endLine, endCharacter)
        );
    }
}
