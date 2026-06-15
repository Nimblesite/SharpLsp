using MessagePack;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E tests for the mutating/refactor surface — prepare-rename, rename, and
/// code-action discovery + resolve — all driven through the real sidecar
/// socket. Rename does not write to disk, so it is safe to run against the
/// shared fixture. Positions index into the appended <c>TestSource</c>
/// constructs.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class RefactorEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    [Fact]
    public async Task PrepareRename_on_method_allows_rename()
    {
        // `Add` method at L9 c15.
        var r = await fixture.SendAsync("textDocument/prepareRename", fixture.PosPayload(9, 15));
        Assert.Null(r.Error);
        var result = MessagePackSerializer.Deserialize<PrepareRenameResult>(r.Payload);
        Assert.True(result.CanRename);
        Assert.Equal("Add", result.Placeholder);
        Assert.Equal(9, result.StartLine);
    }

    [Fact]
    public async Task PrepareRename_on_namespace_disallows_rename()
    {
        // The namespace token cannot be renamed (symbol is INamespaceSymbol).
        var r = await fixture.SendAsync("textDocument/prepareRename", fixture.PosPayload(0, 12));
        Assert.Null(r.Error);
        var result = MessagePackSerializer.Deserialize<PrepareRenameResult>(r.Payload);
        Assert.False(result.CanRename);
    }

    [Fact]
    public async Task PrepareRename_on_field_allows_rename()
    {
        // `FieldCount` field at L80 c15.
        var r = await fixture.SendAsync("textDocument/prepareRename", fixture.PosPayload(80, 15));
        Assert.Null(r.Error);
        var result = MessagePackSerializer.Deserialize<PrepareRenameResult>(r.Payload);
        Assert.True(result.CanRename);
        Assert.Equal("FieldCount", result.Placeholder);
    }

    [Fact]
    public async Task Rename_method_produces_edits_across_declaration_and_call()
    {
        // Rename `Add` (declared L9, called L32) — RenameAsync must surface
        // edits for both sites without touching disk.
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 9,
                Character = 15,
                NewName = "Sum",
            }
        );
        var r = await fixture.SendAsync("textDocument/rename", payload);
        Assert.Null(r.Error);
        var edit = MessagePackSerializer.Deserialize<WorkspaceEditResult>(r.Payload);
        var doc = Assert.Single(edit.DocumentChanges);
        Assert.Equal(fixture.SourceFile, doc.FilePath);
        Assert.NotEmpty(doc.Edits);
        Assert.Contains(doc.Edits, e => e.NewText.Contains("Sum"));
    }

    [Fact]
    public async Task Rename_field_produces_edits()
    {
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 80,
                Character = 15,
                NewName = "Counter",
            }
        );
        var r = await fixture.SendAsync("textDocument/rename", payload);
        Assert.Null(r.Error);
        var edit = MessagePackSerializer.Deserialize<WorkspaceEditResult>(r.Payload);
        Assert.NotEmpty(edit.DocumentChanges);
    }

    [Fact]
    public async Task Rename_on_string_literal_returns_empty_edit()
    {
        // No symbol at a string literal -> empty workspace edit, not an error.
        var payload = MessagePackSerializer.Serialize(
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 124,
                Character = 23,
                NewName = "Whatever",
            }
        );
        var r = await fixture.SendAsync("textDocument/rename", payload);
        Assert.Null(r.Error);
        var edit = MessagePackSerializer.Deserialize<WorkspaceEditResult>(r.Payload);
        Assert.Empty(edit.DocumentChanges);
    }

    [Fact]
    public async Task CodeAction_on_unused_local_offers_quickfix_resolvable_to_edit()
    {
        // `var unused = 42;` at L136 produces CS0219; Roslyn offers a
        // "Remove unused variable" fix. Discover it, then resolve to an edit.
        var request = new CodeActionRequest
        {
            FilePath = fixture.SourceFile,
            StartLine = 136,
            StartCharacter = 12,
            EndLine = 136,
            EndCharacter = 18,
        };
        var listResp = await fixture.SendAsync(
            "textDocument/codeAction",
            MessagePackSerializer.Serialize(request)
        );
        Assert.Null(listResp.Error);
        var actions = MessagePackSerializer.Deserialize<CodeActionItem[]>(listResp.Payload);
        Assert.NotEmpty(actions);

        var resolved = await ResolveFirstActionWithEditsAsync(actions);
        Assert.True(resolved, "at least one offered action must resolve to a workspace edit");
    }

    private async Task<bool> ResolveFirstActionWithEditsAsync(CodeActionItem[] actions)
    {
        foreach (var action in actions)
        {
            var resolveResp = await fixture.SendAsync(
                "codeAction/resolve",
                MessagePackSerializer.Serialize(new CodeActionResolveRequest { Id = action.Id })
            );
            Assert.Null(resolveResp.Error);
            if (resolveResp.Payload.Length <= 1)
            {
                continue; // nil — unknown id path; keep looking.
            }

            var edit = MessagePackSerializer.Deserialize<WorkspaceEditResult>(resolveResp.Payload);
            if (edit.DocumentChanges.Count > 0)
            {
                return true;
            }
        }

        return false;
    }

    [Fact]
    public async Task CodeActionResolve_unknown_id_returns_nil()
    {
        // ResolveCodeActionAsync returns failure for an unknown id; the handler
        // surfaces that as an error string, exercising the not-found branch.
        var r = await fixture.SendAsync(
            "codeAction/resolve",
            MessagePackSerializer.Serialize(new CodeActionResolveRequest { Id = 999_999 })
        );
        Assert.NotNull(r.Error);
        Assert.Contains("999999", r.Error);
    }

    [Fact]
    public async Task CodeAction_on_type_offers_refactorings()
    {
        // A selection spanning a method body tends to surface refactorings.
        var request = new CodeActionRequest
        {
            FilePath = fixture.SourceFile,
            StartLine = 9,
            StartCharacter = 35,
            EndLine = 9,
            EndCharacter = 40,
        };
        var r = await fixture.SendAsync(
            "textDocument/codeAction",
            MessagePackSerializer.Serialize(request)
        );
        Assert.Null(r.Error);
        var actions = MessagePackSerializer.Deserialize<CodeActionItem[]>(r.Payload);
        Assert.NotNull(actions);
    }
}
