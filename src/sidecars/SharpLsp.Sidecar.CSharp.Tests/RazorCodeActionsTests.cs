using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;
using static SharpLsp.Sidecar.CSharp.Tests.TextEditing;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real-file reads are intentional in this end-to-end suite
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Razor code actions against the real fixture: <c>@using</c> for an unbound type or an unknown
/// component tag, a generated event handler, a component's <c>@code</c> block moved into a
/// code-behind partial class, and sibling elements moved into a new component. Each action's
/// edit is applied and the result re-read through the workspace. Implements [RAZOR-TESTING] for
/// [RAZOR-CODE-ACTIONS].
/// </summary>
public sealed class RazorCodeActionsTests : IClassFixture<RazorFixture>
{
    private readonly RazorFixture _fixture;

    public RazorCodeActionsTests(RazorFixture fixture)
    {
        _fixture = fixture;
    }

    private string Counter => _fixture.Path("BlazorApp", "Components", "Pages", "Counter.razor");

    [Fact]
    public async Task An_unbound_type_offers_its_namespace_as_an_at_using()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var original = await File.ReadAllTextAsync(Counter);
        var text = original.Replace(
            "<h1>Counter</h1>",
            "<h1>Counter</h1>\n<p>@(new StringBuilder(\"x\"))</p>",
            StringComparison.Ordinal
        );
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, text));
        Assert.Contains(await ErrorsAsync(manager, Counter), code => code == "CS0246");

        // The fix names the namespace and is preferred: it is the only one. [RAZOR-CODE-ACTIONS-USING]
        var at = Find(text, "StringBuilder");
        var action = Assert.Single(
            await ActionsAsync(manager, Counter, at),
            a => a.Title == "@using System.Text"
        );
        Assert.Equal("quickfix", action.Kind);
        Assert.True(action.IsPreferred);

        // Its edit adds an `@using` line, and the file then compiles.
        var edit = await ResolveAsync(manager, action);
        var change = Assert.Single(edit.DocumentChanges);
        Assert.True(NativePaths.AreEqual(Counter, change.FilePath));
        var fixedText = ApplyEdits(text, change.Edits);
        Assert.Contains("@using System.Text\n", fixedText, StringComparison.Ordinal);
        Assert.StartsWith("@page \"/counter\"", fixedText, StringComparison.Ordinal);
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, fixedText));
        Assert.DoesNotContain(await ErrorsAsync(manager, Counter), code => code == "CS0246");
        Assert.DoesNotContain(
            await ActionsAsync(manager, Counter, Find(fixedText, "StringBuilder")),
            a => a.Title.StartsWith("@using", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task An_unknown_component_tag_offers_the_namespace_that_declares_it()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = (await File.ReadAllTextAsync(Counter)).Replace(
            "<h1>Counter</h1>",
            "<h1>Counter</h1>\n<Virtualize TItem=\"int\" />",
            StringComparison.Ordinal
        );
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, text));

        // RZ10012 names an element the compiler cannot bind: its component's namespace fixes it.
        var at = Find(text, "Virtualize");
        var action = Assert.Single(
            await ActionsAsync(manager, Counter, at),
            a => a.Title == "@using Microsoft.AspNetCore.Components.Web.Virtualization"
        );
        Assert.True(action.IsPreferred);
        var edit = await ResolveAsync(manager, action);
        var fixedText = ApplyEdits(text, Assert.Single(edit.DocumentChanges).Edits);
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, fixedText));
        var markup = await manager.FindRazorMarkupAsync(Counter, default);
        Assert.NotNull(markup);
        Assert.DoesNotContain(markup.Diagnostics, diagnostic => diagnostic.Id == "RZ10012");
        Assert.Contains(markup.Tags, tag => tag.Name == "Virtualize" && tag.Component is not null);
    }

    [Fact]
    public async Task A_missing_event_handler_is_generated_in_the_code_block()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = (await File.ReadAllTextAsync(Counter)).Replace(
            "<h1>Counter</h1>",
            "<h1 @onclick=\"Reset\">Counter</h1>",
            StringComparison.Ordinal
        );
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, text));

        // The handler takes the event's argument type, as the file can name it. [RAZOR-CODE-ACTIONS-HANDLER]
        var action = Assert.Single(
            await ActionsAsync(manager, Counter, Find(text, "Reset")),
            a => a.Title == "Generate event handler 'Reset'"
        );
        var edit = await ResolveAsync(manager, action);
        var generated = ApplyEdits(text, Assert.Single(edit.DocumentChanges).Edits);
        Assert.Contains(
            "        currentCount++;\n    }\n\n    private void Reset(MouseEventArgs args)\n    {\n    }\n}",
            generated,
            StringComparison.Ordinal
        );
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, generated));
        Assert.Empty(await ErrorsAsync(manager, Counter));

        // A component's EventCallback<string> parameter takes a string, and a file with no
        // code block gets one at its end.
        var tally = _fixture.Path("BlazorApp", "Components", "Pages", "Leaders.razor");
        var leaders = (await File.ReadAllTextAsync(tally)).Replace(
            "@code {",
            "<Tally TItem=\"int\" Items=\"[]\" LabelChanged=\"Relabel\" />\n\n@code {",
            StringComparison.Ordinal
        );
        var withoutCode =
            leaders[..leaders.IndexOf("@code {", StringComparison.Ordinal)].TrimEnd() + "\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(tally, withoutCode));
        var relabel = Assert.Single(
            await ActionsAsync(manager, tally, Find(withoutCode, "Relabel")),
            a => a.Title == "Generate event handler 'Relabel'"
        );
        var appended = ApplyEdits(
            withoutCode,
            Assert.Single((await ResolveAsync(manager, relabel)).DocumentChanges).Edits
        );
        Assert.EndsWith(
            "LabelChanged=\"Relabel\" />\n\n@code {\n    private void Relabel(string args)\n    {\n    }\n}\n",
            appended,
            StringComparison.Ordinal
        );

        // A name that is not passed to a callback offers no handler.
        Assert.DoesNotContain(
            await ActionsAsync(manager, tally, Find(withoutCode, "Scoring.total")),
            a => a.Title.StartsWith("Generate event handler", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task A_code_block_moves_into_a_code_behind_partial_class()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Counter);

        // Offered on `@code` of a component with no code-behind. [RAZOR-CODE-ACTIONS-CODE-BEHIND]
        var action = Assert.Single(
            await ActionsAsync(manager, Counter, Find(text, "@code")),
            a => a.Title == "Extract block to code behind"
        );
        Assert.Equal("refactor.extract", action.Kind);
        var edit = await ResolveAsync(manager, action);
        Assert.Equal(2, edit.DocumentChanges.Count);
        var created = edit.DocumentChanges[0];
        Assert.True(created.Create);
        Assert.True(NativePaths.AreEqual(NativePaths.CodeBehindOf(Counter), created.FilePath));
        var codeBehind = Assert.Single(created.Edits).NewText;
        Assert.Contains(
            "namespace BlazorApp.Components.Pages;\n",
            codeBehind,
            StringComparison.Ordinal
        );
        Assert.Contains(
            "public partial class Counter\n{\n    private int currentCount = 0;",
            codeBehind,
            StringComparison.Ordinal
        );
        Assert.Contains(
            "using Microsoft.AspNetCore.Components.Web;\n",
            codeBehind,
            StringComparison.Ordinal
        );
        Assert.DoesNotContain("using System;", codeBehind, StringComparison.Ordinal);
        Assert.EndsWith("    }\n}\n", codeBehind, StringComparison.Ordinal);

        // The Razor file keeps its markup and loses the block.
        var razor = edit.DocumentChanges[1];
        Assert.False(razor.Create);
        var remaining = ApplyEdits(text, razor.Edits);
        Assert.DoesNotContain("@code", remaining, StringComparison.Ordinal);
        Assert.EndsWith("Click me</button>\n\n", remaining, StringComparison.Ordinal);

        // Badge has a block, but its code-behind already exists: no second one.
        var badge = _fixture.Path("BlazorApp", "Components", "Shared", "Badge.razor");
        Assert.DoesNotContain(
            await ActionsAsync(manager, badge, (0, 0)),
            a => a.Title == "Extract block to code behind"
        );
    }

    [Fact]
    public async Task Sibling_elements_move_into_a_new_component_only_when_they_stand_alone()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text = await File.ReadAllTextAsync(Counter);

        // `<h1>` names nothing of the component: it moves into Component.razor. [RAZOR-CODE-ACTIONS-COMPONENT]
        var heading = Find(text, "<h1>Counter</h1>");
        var action = Assert.Single(
            await ActionsAsync(
                manager,
                Counter,
                heading,
                (heading.Line, heading.Character + "<h1>Counter</h1>".Length)
            ),
            a => a.Title == "Extract element to new component 'Component'"
        );
        var edit = await ResolveAsync(manager, action);
        var created = edit.DocumentChanges[0];
        Assert.True(created.Create);
        Assert.True(
            NativePaths.AreEqual(
                _fixture.Path("BlazorApp", "Components", "Pages", "Component.razor"),
                created.FilePath
            )
        );
        Assert.Equal("<h1>Counter</h1>\n", Assert.Single(created.Edits).NewText);
        var replaced = ApplyEdits(text, edit.DocumentChanges[1].Edits);
        Assert.Contains(
            "<PageTitle>Counter</PageTitle>\n\n<Component />\n",
            replaced,
            StringComparison.Ordinal
        );

        // `<p>` reads the component's field, which the new component could not see.
        var status = Find(text, "<p role=");
        var line = text.Split('\n')[status.Line];
        Assert.DoesNotContain(
            await ActionsAsync(manager, Counter, status, (status.Line, line.Length)),
            a => a.Title.StartsWith("Extract element", StringComparison.Ordinal)
        );

        // A selection that is not whole elements offers nothing.
        Assert.DoesNotContain(
            await ActionsAsync(manager, Counter, heading, (heading.Line, heading.Character + 6)),
            a => a.Title.StartsWith("Extract element", StringComparison.Ordinal)
        );
    }

    [Fact]
    public async Task Extraction_trims_the_selection_dedents_it_and_refuses_outside_locals()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var text =
            await File.ReadAllTextAsync(Counter)
            + "\n<div>\n    <section>\n        <h2>Nested</h2>\n    </section>\n</div>\n"
            + "@foreach (var item in new[] { 1, 2 })\n{\n    <span>@item</span>\n}\n"
            + "<em>@(new[] { 1 }.Select(n => n + 1).First())</em>\n";
        _ = RazorFixture.Ok(await manager.UpdateDocumentTextAsync(Counter, text));

        // The selection's surrounding whitespace is not part of it, and each line of the
        // element loses the first line's indentation. [RAZOR-CODE-ACTIONS-COMPONENT]
        var section = Find(text, "    <section>");
        var close = Find(text, "</div>");
        var action = Assert.Single(
            await ActionsAsync(manager, Counter, (section.Line, 0), (close.Line, 0)),
            a => a.Title == "Extract element to new component 'Component'"
        );
        var edit = await ResolveAsync(manager, action);
        Assert.Equal(
            "<section>\n    <h2>Nested</h2>\n</section>\n",
            Assert.Single(edit.DocumentChanges[0].Edits).NewText
        );
        Assert.Contains(
            "<div>\n    <Component />\n</div>\n",
            ApplyEdits(text, edit.DocumentChanges[1].Edits),
            StringComparison.Ordinal
        );

        // A local declared outside the selection is out of the new component's reach.
        var span = Find(text, "<span>@item</span>");
        Assert.DoesNotContain(
            await ActionsAsync(
                manager,
                Counter,
                span,
                (span.Line, span.Character + "<span>@item</span>".Length)
            ),
            a => a.Title.StartsWith("Extract element", StringComparison.Ordinal)
        );

        // One declared inside it, a lambda's parameter, moves with it.
        const string emphasis = "<em>@(new[] { 1 }.Select(n => n + 1).First())</em>";
        var em = Find(text, emphasis);
        _ = Assert.Single(
            await ActionsAsync(manager, Counter, em, (em.Line, em.Character + emphasis.Length)),
            a => a.Title == "Extract element to new component 'Component'"
        );
    }

    private static (int Line, int Character) Find(string text, string token)
    {
        var lines = text.Split('\n');
        var line = Array.FindIndex(lines, l => l.Contains(token, StringComparison.Ordinal));
        Assert.True(line >= 0, $"missing {token}");
        return (line, lines[line].IndexOf(token, StringComparison.Ordinal));
    }

    private static async Task<List<CodeActionItem>> ActionsAsync(
        WorkspaceManager manager,
        string file,
        (int Line, int Character) start,
        (int Line, int Character)? end = null
    )
    {
        var (endLine, endCharacter) = end ?? start;
        return RazorFixture.Ok(
            await manager.GetCodeActionsAsync(
                file,
                start.Line,
                start.Character,
                endLine,
                endCharacter
            )
        );
    }

    private static async Task<WorkspaceEditResult> ResolveAsync(
        WorkspaceManager manager,
        CodeActionItem action
    )
    {
        Assert.True(action.Id < 0, "a Razor action has its own id");
        return RazorFixture.Ok(await manager.ResolveCodeActionAsync(action.Id));
    }

    private static async Task<List<string>> ErrorsAsync(WorkspaceManager manager, string file)
    {
        return
        [
            .. RazorFixture
                .Ok(await manager.GetDiagnosticsAsync(file))
                .Where(diagnostic => diagnostic.Severity == "Error")
                .Select(diagnostic => diagnostic.Code),
        ];
    }
}
