using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>Applies a sidecar's text edits the way an editor does, for tests to read the result.</summary>
internal static class TextEditing
{
    /// <summary><paramref name="source"/> with every one of <paramref name="edits"/> applied at once.</summary>
    internal static string ApplyEdits(string source, IEnumerable<TextEditResult> edits)
    {
        var text = SourceText.From(source);
        var changes = edits.Select(edit => new TextChange(EditSpan(text, edit), edit.NewText));
        return text.WithChanges(changes).ToString();
    }

    /// <summary>The span of <paramref name="text"/> that <paramref name="edit"/> replaces.</summary>
    internal static TextSpan EditSpan(SourceText text, TextEditResult edit)
    {
        var start = text.Lines.GetPosition(new LinePosition(edit.StartLine, edit.StartCharacter));
        var end = text.Lines.GetPosition(new LinePosition(edit.EndLine, edit.EndCharacter));
        return TextSpan.FromBounds(start, end);
    }
}
