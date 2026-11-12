using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Roslyn rename locations that span declarations and structured references.</summary>
public sealed class WorkspaceManagerRenameRoslynEditsTests(
    WorkspaceManagerQueryFixture fixture
) : IClassFixture<WorkspaceManagerQueryFixture>
{
    /// <summary>[RENAME-CSHARP] Roslyn's edits must survive LSP conversion intact.</summary>
    [Theory]
    [InlineData("public partial class PartialThing", "PartialThing", "RenamedThing", 4)]
    [InlineData("void Execute();", "Execute", "Perform", 4)]
    public async Task Rename_preserves_partial_xml_nameof_and_explicit_interface_edits(
        string marker, string oldName, string newName, int expectedCount
    )
    {
        var source = WorkspaceManagerQueryFixture.Source;
        var offset = source.IndexOf(marker, StringComparison.Ordinal)
            + marker.IndexOf(oldName, StringComparison.Ordinal);
        var position = SourceText.From(source).Lines.GetLinePosition(offset);
        var result = await fixture.Manager.RenameAsync(
            fixture.SourcePath, position.Line, position.Character, newName
        );
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var document = Assert.Single((+result).DocumentChanges);
        Assert.Equal(expectedCount, document.Edits.Count);
        Assert.All(document.Edits, edit => Assert.Equal(newName, edit.NewText));
        Assert.Equal(
            source.Replace(oldName, newName, StringComparison.Ordinal),
            TextEditing.ApplyEdits(source, document.Edits)
        );
    }

    /// <summary>[RENAME-COVERAGE] Rename a bound user-defined operator and its use.</summary>
    [Fact]
    public async Task Rename_operator_changes_declaration_and_bound_expression()
    {
        var source = WorkspaceManagerQueryFixture.Source;
        var offset = source.IndexOf("operator +(Number", StringComparison.Ordinal) + "operator ".Length;
        var position = SourceText.From(source).Lines.GetLinePosition(offset);
        var prepared = await fixture.Manager.PrepareRenameAsync(fixture.SourcePath, position.Line, position.Character);
        Assert.False(prepared.IsError, prepared.Match(_ => "ok", error => error));
        Assert.True((+prepared).CanRename);
        Assert.Equal("+", (+prepared).Placeholder);
        var result = await fixture.Manager.RenameAsync(fixture.SourcePath, position.Line, position.Character, "-");
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var document = Assert.Single((+result).DocumentChanges);
        Assert.Equal(3, document.Edits.Count);
        Assert.Equal(
            source.Replace("operator +(Number a, Number b)", "operator -(Number a, Number b)", StringComparison.Ordinal)
                .Replace(
                    "public static Number Sum(Number a, Number b) => a + b;",
                    "public static Number Sum(Number a, Number b) => a - b;",
                    StringComparison.Ordinal
                )
                .Replace("a += b;", "a -= b;", StringComparison.Ordinal),
            TextEditing.ApplyEdits(source, document.Edits)
        );

        var useOffset = source.IndexOf("public static Number Sum", StringComparison.Ordinal)
            + "public static Number Sum(Number a, Number b) => a ".Length;
        var usePosition = SourceText.From(source).Lines.GetLinePosition(useOffset);
        var fromUse = await fixture.Manager.RenameAsync(fixture.SourcePath, usePosition.Line, usePosition.Character, "-");
        Assert.False(fromUse.IsError, fromUse.Match(_ => "ok", error => error));
        var useDocument = Assert.Single((+fromUse).DocumentChanges);
        Assert.Equal(document.Edits, useDocument.Edits);
    }

    /// <summary>[RENAME-PREPARE] Unary operators are excluded until their metadata mapping is supported.</summary>
    [Fact]
    public async Task Prepare_rename_rejects_unsupported_unary_operator()
    {
        var source = WorkspaceManagerQueryFixture.Source;
        var offset = source.IndexOf("operator +(Number a) =>", StringComparison.Ordinal) + "operator ".Length;
        var position = SourceText.From(source).Lines.GetLinePosition(offset);
        var prepared = await fixture.Manager.PrepareRenameAsync(fixture.SourcePath, position.Line, position.Character);
        Assert.False(prepared.IsError, prepared.Match(_ => "ok", error => error));
        Assert.False((+prepared).CanRename);
    }

    /// <summary>[RENAME-ERRORS] An existing operator signature blocks the rename.</summary>
    [Fact]
    public async Task Rename_operator_rejects_duplicate_signature()
    {
        var source = WorkspaceManagerQueryFixture.Source;
        var marker = "operator +(ConflictingNumber";
        var offset = source.IndexOf(marker, StringComparison.Ordinal) + "operator ".Length;
        var position = SourceText.From(source).Lines.GetLinePosition(offset);
        var result = await fixture.Manager.RenameAsync(fixture.SourcePath, position.Line, position.Character, "-");
        Assert.True(result.IsError);
    }
}
