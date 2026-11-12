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
}
