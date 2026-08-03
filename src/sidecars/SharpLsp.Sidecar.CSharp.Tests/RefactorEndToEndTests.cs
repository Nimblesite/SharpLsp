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
        var result = await fixture.SendAndDeserializeAsync<PrepareRenameResult>(
            "textDocument/prepareRename",
            fixture.PosPayload(9, 15)
        );
        Assert.True(result.CanRename);
        Assert.Equal("Add", result.Placeholder);
        Assert.Equal(9, result.StartLine);
    }

    [Fact]
    public async Task PrepareRename_on_namespace_reports_exact_identifier()
    {
        var result = await fixture.SendAndDeserializeAsync<PrepareRenameResult>(
            "textDocument/prepareRename",
            fixture.PosPayload(0, 12)
        );
        Assert.True(result.CanRename);
        Assert.Equal("TestProject", result.Placeholder);
        Assert.Equal(0, result.StartLine);
        Assert.Equal(10, result.StartCharacter);
        Assert.Equal(0, result.EndLine);
        Assert.Equal(21, result.EndCharacter);
    }

    [Fact]
    public async Task PrepareRename_on_field_allows_rename()
    {
        // `FieldCount` field at L80 c15.
        var result = await fixture.SendAndDeserializeAsync<PrepareRenameResult>(
            "textDocument/prepareRename",
            fixture.PosPayload(80, 15)
        );
        Assert.True(result.CanRename);
        Assert.Equal("FieldCount", result.Placeholder);
    }

    [Fact]
    public async Task PrepareRename_on_string_literal_is_rejected()
    {
        // [RENAME-ERRORS] Non-identifiers are a successful negative result.
        var result = await fixture.SendAndDeserializeAsync<PrepareRenameResult>(
            "textDocument/prepareRename",
            fixture.PosPayload(124, 23)
        );
        Assert.False(result.CanRename);
    }

    [Fact]
    public async Task Rename_method_produces_edits_across_declaration_and_call()
    {
        // Rename `Add` (declared L9, called L32) — RenameAsync must surface
        // edits for both sites without touching disk.
        var edit = await fixture.SendAndDeserializeAsync<RenameRequest, WorkspaceEditResult>(
            "textDocument/rename",
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 9,
                Character = 15,
                NewName = "Sum",
            }
        );
        var doc = Assert.Single(edit.DocumentChanges);
        Assert.Equal(fixture.SourceFile, doc.FilePath);
        Assert.NotEmpty(doc.Edits);
        Assert.Contains(doc.Edits, e => e.NewText.Contains("Sum"));
    }

    [Fact]
    public async Task Rename_field_produces_edits()
    {
        var edit = await fixture.SendAndDeserializeAsync<RenameRequest, WorkspaceEditResult>(
            "textDocument/rename",
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 80,
                Character = 15,
                NewName = "Counter",
            }
        );
        Assert.NotEmpty(edit.DocumentChanges);
    }

    [Fact]
    public async Task Rename_on_string_literal_returns_empty_edit()
    {
        // No symbol at a string literal -> empty workspace edit, not an error.
        var edit = await fixture.SendAndDeserializeAsync<RenameRequest, WorkspaceEditResult>(
            "textDocument/rename",
            new RenameRequest
            {
                FilePath = fixture.SourceFile,
                Line = 124,
                Character = 23,
                NewName = "Whatever",
            }
        );
        Assert.Empty(edit.DocumentChanges);
    }

    [Theory]
    [InlineData(3, 13, "Calculator")]
    [InlineData(3, 13, "   ")]
    [InlineData(3, 13, "bad-name")]
    [InlineData(3, 13, "Program")]
    [InlineData(0, 12, "MetaProbe")]
    public async Task Rename_rejects_invalid_unchanged_and_conflicting_names(
        int line,
        int character,
        string newName
    )
    {
        // [RENAME-ERRORS] Rejected names never leak partial Roslyn edits.
        var edit = await fixture.SendAndDeserializeAsync<RenameRequest, WorkspaceEditResult>(
            "textDocument/rename",
            RenameRequestAt(line, character, newName)
        );
        Assert.Empty(edit.DocumentChanges);
    }

    private RenameRequest RenameRequestAt(int line, int character, string newName)
    {
        return new RenameRequest
        {
            FilePath = fixture.SourceFile,
            Line = line,
            Character = character,
            NewName = newName,
        };
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
        var actions = await fixture.SendAndDeserializeAsync<CodeActionItem[]>(
            "textDocument/codeAction",
            MessagePackSerializer.Serialize(request)
        );
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
        var actions = await fixture.SendAndDeserializeAsync<CodeActionItem[]>(
            "textDocument/codeAction",
            MessagePackSerializer.Serialize(request)
        );
        Assert.NotNull(actions);
    }
}
