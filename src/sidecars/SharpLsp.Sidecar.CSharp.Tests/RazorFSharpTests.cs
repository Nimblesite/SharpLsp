using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// F# in a Razor solution, against the real fixture: BlazorApp's <c>Leaders.razor</c> uses
/// the F# <c>Domain</c> library's record, union and module functions. The C# sidecar reads
/// them from Domain's built DLL, answers hover, completion and signature help from that
/// metadata, and names each F# symbol by its identity for the F# sidecar: on definition,
/// on rename and for the other language's references. Implements [RAZOR-TESTING] for
/// [RAZOR-FSHARP] and [DEFINITION-CROSSLANG-IDENTITY].
/// </summary>
public sealed class RazorFSharpTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorFSharpTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Leaders => _fixture.Path("BlazorApp", "Components", "Pages", "Leaders.razor");

    [Fact]
    public async Task Hover_and_signature_help_read_FSharp_symbols_from_their_assembly()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // A record, a record field and a module function, with their F# documentation.
        var player = await HoverAsync(manager, At("private readonly Player[]", "Player"));
        Assert.Contains("Player", player, StringComparison.Ordinal);
        Assert.Contains("A player on the leader board.", player, StringComparison.Ordinal);
        var score = await HoverAsync(manager, At("@player.Score", "Score"));
        Assert.Contains("int", score, StringComparison.Ordinal);
        Assert.Contains("The points the player has scored.", score, StringComparison.Ordinal);
        var total = await HoverAsync(manager, At("@Scoring.total", "total"));
        Assert.Contains("The sum of every player", total, StringComparison.Ordinal);
        Assert.Contains("public static int Domain.Scoring.total(", total, StringComparison.Ordinal);
        Assert.Contains("IEnumerable<", total, StringComparison.Ordinal);
        Assert.Contains("Player> players)", total, StringComparison.Ordinal);

        // A curried F# function is a method of every parameter to C#.
        var (line, character) = At("Scoring.standing(players", "players");
        var help = RazorFixture.Ok(await manager.GetSignatureHelpAsync(Leaders, line, character));
        Assert.NotNull(help);
        var signature = Assert.Single(help.Signatures);
        Assert.Contains("standing", signature.Label, StringComparison.Ordinal);
        Assert.Equal(2, signature.Parameters.Count);
        Assert.Contains(
            signature.Parameters,
            parameter => parameter.Contains("field", StringComparison.Ordinal)
        );
        Assert.Equal(0, help.ActiveParameter);
    }

    [Fact]
    public async Task Completion_offers_FSharp_members_in_markup_and_code()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var original = await File.ReadAllTextAsync(Leaders);

        // After `@player.` in markup: the record's fields, documented.
        var markup = await CompletedAtAsync(manager, original, "@player.Name", "Name");
        var name = Assert.Single(markup, item => item.Label == "Name");
        Assert.Contains(markup, item => item.Label == "Score");
        Assert.Equal("Property", name.Kind);

        // After `Scoring.` in `@code`: the module's functions; after a union value, its cases' tests.
        var code = original.Replace(
            "private static string Describe",
            "private int Probe() => Scoring.\n    private static string Describe",
            StringComparison.Ordinal
        );
        var functions = await CompletedAfterAsync(manager, code, "Scoring.\n");
        Assert.Contains(functions, item => item.Label == "total");
        Assert.Contains(functions, item => item.Label == "standing");
        var cases = await CompletedAfterAsync(
            manager,
            original.Replace("standing.IsLeading", "standing.", StringComparison.Ordinal),
            "=> standing."
        );
        Assert.Contains(cases, item => item.Label == "IsLeading");
        Assert.Contains(cases, item => item.Label == "IsChasing");
    }

    [Fact]
    public async Task Definition_names_each_FSharp_symbol_for_the_FSharp_sidecar()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // A type, a record field and a function each land in Domain's decompiled source,
        // named by their assembly and XML doc signature. [DEFINITION-CROSSLANG-IDENTITY]
        Assert.Equal(
            "T:Domain.Player",
            await DefinedAsync(manager, At("private readonly Player[]", "Player"))
        );
        Assert.Equal(
            "P:Domain.Player.Score",
            await DefinedAsync(manager, At("@player.Score", "Score"))
        );
        Assert.Equal(
            "M:Domain.Scoring.total(System.Collections.Generic.IEnumerable{Domain.Player})",
            await DefinedAsync(manager, At("@Scoring.total", "total"))
        );

        // A record's constructor is named by its type: F# declares it there.
        Assert.Equal("T:Domain.Player", await DefinedAsync(manager, At("[new Player(", "Player")));

        // Type definition and declaration name the symbol the same way.
        var (line, character) = At("var player in players", "player");
        var type = RazorFixture.Ok(await manager.GetTypeDefinitionAsync(Leaders, line, character));
        Assert.NotNull(type);
        Assert.Equal("T:Domain.Player", type.Symbol?.XmlDocSig);
        Assert.Equal("Domain", type.Symbol?.AssemblyName);

        // A framework symbol has no F# declaration, so its location names none.
        var (stringLine, stringCharacter) = At("private static string Describe", "string");
        var framework = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Leaders, stringLine, stringCharacter))
                .Locations
        );
        Assert.Null(framework.Symbol);
    }

    [Fact]
    public async Task Rename_from_Razor_renames_an_FSharp_symbol_in_CSharp_and_Razor()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (line, character) = At("@player.Score", "Score");

        // An F# record field is renameable from Razor, on its name. [RAZOR-FSHARP-RENAME]
        var prepared = RazorFixture.Ok(await manager.PrepareRenameAsync(Leaders, line, character));
        Assert.True(prepared.CanRename);
        Assert.Equal((line, character), (prepared.StartLine, prepared.StartCharacter));
        Assert.Equal(character + "Score".Length, prepared.EndCharacter);
        Assert.Equal("Score", prepared.Placeholder);

        // The C# sidecar edits its Razor and C# uses; F#'s come from the F# sidecar.
        var edit = RazorFixture.Ok(await manager.RenameAsync(Leaders, line, character, "Points"));
        var razor = Assert.Single(
            edit.DocumentChanges,
            d => NativePaths.AreEqual(Leaders, d.FilePath)
        );
        var renamed = Assert.Single(razor.Edits);
        Assert.Equal((line, character), (renamed.StartLine, renamed.StartCharacter));
        Assert.Equal("Points", renamed.NewText);
        Assert.DoesNotContain(
            edit.DocumentChanges,
            d => NativePaths.HasExtension(d.FilePath, ".g.cs")
        );
        Assert.DoesNotContain(
            edit.DocumentChanges,
            d => NativePaths.HasExtension(d.FilePath, ".fs")
        );

        // The identity the host asks F# with comes through the projection too.
        var identity = RazorFixture.Ok(
            await manager.GetRenameIdentityAsync(Leaders, line, character)
        );
        Assert.True(identity.Found);
        Assert.Equal(
            ("Domain", "P:Domain.Player.Score"),
            (identity.AssemblyName, identity.XmlDocSig)
        );
        var (describeLine, describeCharacter) = At("@Describe(", "Describe");
        var own = RazorFixture.Ok(
            await manager.GetRenameIdentityAsync(Leaders, describeLine, describeCharacter)
        );
        Assert.True(own.Found);
        Assert.Equal("BlazorApp", own.AssemblyName);
        Assert.StartsWith("M:", own.XmlDocSig, StringComparison.Ordinal);
        Assert.EndsWith(".Describe(Domain.Standing)", own.XmlDocSig, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Foreign_references_and_rename_reach_Razor_uses_of_an_FSharp_symbol()
    {
        using var manager = await _fixture.OpenManagerAsync();

        // The F# sidecar names `Score`; C# answers its Razor uses, mapped to the Razor file.
        var score = RazorFixture.Ok(
            await manager.GetForeignReferencesAsync(
                new ForeignSymbolQuery("Domain", "P:Domain.Player.Score", true)
            )
        );
        var use = Assert.Single(score.Locations);
        Assert.True(NativePaths.AreEqual(Leaders, use.FilePath), use.FilePath);
        Assert.Equal(At("@player.Score", "Score"), (use.Line, use.Character));

        // `Player` is used three times: the field's type and both constructions.
        var player = RazorFixture.Ok(
            await manager.GetForeignReferencesAsync(
                new ForeignSymbolQuery("Domain", "T:Domain.Player", false)
            )
        );
        Assert.Equal(3, player.Locations.Count);
        Assert.All(
            player.Locations,
            location => Assert.True(NativePaths.AreEqual(Leaders, location.FilePath))
        );
        Assert.Contains(
            At("private readonly Player[]", "Player"),
            player.Locations.Select(l => (l.Line, l.Character))
        );

        // An F#-origin rename edits the Razor use, never the generated file.
        var rename = RazorFixture.Ok(
            await manager.RenameForeignAsync("Domain", "P:Domain.Player.Score", "Points")
        );
        var edits = Assert.Single(rename.DocumentChanges);
        Assert.True(NativePaths.AreEqual(Leaders, edits.FilePath), edits.FilePath);
        Assert.Equal("Points", Assert.Single(edits.Edits).NewText);

        // A symbol no project reads has no uses.
        var none = RazorFixture.Ok(
            await manager.GetForeignReferencesAsync(
                new ForeignSymbolQuery("Domain", "T:Domain.Missing", true)
            )
        );
        Assert.Empty(none.Locations);

        // An identity naming no assembly or signature finds nothing, and neither does a
        // workspace with no solution loaded.
        var unnamed = RazorFixture.Ok(
            await manager.GetForeignReferencesAsync(
                new ForeignSymbolQuery("", "T:Domain.Player", true)
            )
        );
        Assert.Empty(unnamed.Locations);
        using var unloaded = new WorkspaceManager();
        Assert.Empty(
            RazorFixture
                .Ok(
                    await unloaded.GetForeignReferencesAsync(
                        new ForeignSymbolQuery("Domain", "T:Domain.Player", true)
                    )
                )
                .Locations
        );

        // A cancelled request is a failure, never a partial list.
        var cancelled = await manager.GetForeignReferencesAsync(
            new ForeignSymbolQuery("Domain", "T:Domain.Player", true),
            new CancellationToken(true)
        );
        Assert.True(cancelled.IsError, "a cancelled request fails");
    }

    private (int Line, int Character) At(string anchor, string token)
    {
        return RazorFixture.Locate(Leaders, anchor, token);
    }

    private async Task<string> HoverAsync(WorkspaceManager manager, (int Line, int Character) at)
    {
        var hover = RazorFixture.Ok(await manager.GetHoverAsync(Leaders, at.Line, at.Character));
        Assert.NotNull(hover);
        return hover.Contents;
    }

    /// <summary>The XML doc signature the single definition location at <paramref name="at"/> names, in Domain.</summary>
    private async Task<string?> DefinedAsync(WorkspaceManager manager, (int Line, int Character) at)
    {
        var location = Assert.Single(
            RazorFixture
                .Ok(await manager.GetDefinitionAsync(Leaders, at.Line, at.Character))
                .Locations
        );
        Assert.False(NativePaths.AreEqual(Leaders, location.FilePath), location.FilePath);
        Assert.NotNull(location.Symbol);
        Assert.True(location.Symbol.Found);
        Assert.Equal("Domain", location.Symbol.AssemblyName);
        return location.Symbol.XmlDocSig;
    }

    /// <summary>The completion at <paramref name="token"/> on <paramref name="anchor"/>'s line of <paramref name="text"/>.</summary>
    private async Task<List<CompletionItem>> CompletedAtAsync(
        WorkspaceManager manager,
        string text,
        string anchor,
        string token
    )
    {
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Leaders, text));
        var (line, character) = At(anchor, token);
        return RazorFixture.Ok(await manager.GetCompletionsAsync(Leaders, line, character));
    }

    /// <summary>The completion right after <paramref name="marker"/> in <paramref name="text"/>.</summary>
    private async Task<List<CompletionItem>> CompletedAfterAsync(
        WorkspaceManager manager,
        string text,
        string marker
    )
    {
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Leaders, text));
        var offset = text.IndexOf(marker, StringComparison.Ordinal) + marker.TrimEnd('\n').Length;
        var before = text[..offset].Split('\n');
        return RazorFixture.Ok(
            await manager.GetCompletionsAsync(Leaders, before.Length - 1, before[^1].Length)
        );
    }
}
