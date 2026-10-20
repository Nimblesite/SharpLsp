using Microsoft.CodeAnalysis.Text;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// Maps answers computed on a projection back to its Razor file. A range that does not lie
/// inside one C# fragment cannot be placed, so it is dropped with whatever carries it.
/// Implements [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
internal static class RazorResults
{
    /// <summary>Completion items whose edit maps into the Razor file; the rest are dropped.</summary>
    public static List<CompletionItem> MapCompletions(
        List<CompletionItem> items,
        RazorProjection? origin
    )
    {
        return origin is null
            ? items
            : [.. items.Select(item => MapCompletion(item, origin)).OfType<CompletionItem>()];
    }

    /// <summary>A text edit placed in the Razor file, or null when it crosses a fragment's edge.</summary>
    public static TextEditResult? MapEdit(TextEditResult edit, RazorProjection origin)
    {
        return origin.ToRazor(SpanOf(edit)) is { } razor ? Edit(razor, edit.NewText) : null;
    }

    /// <summary>The prepared range in the Razor file; a range outside every fragment cannot be renamed there.</summary>
    public static PrepareRenameResult MapPrepareRename(
        PrepareRenameResult prepared,
        RazorProjection? origin
    )
    {
        if (origin is null || !prepared.CanRename)
        {
            return prepared;
        }

        var span = new LinePositionSpan(
            new LinePosition(prepared.StartLine, prepared.StartCharacter),
            new LinePosition(prepared.EndLine, prepared.EndCharacter)
        );
        return origin.ToRazor(span) is { } razor
            ? Prepared(razor, prepared.Placeholder)
            : new PrepareRenameResult { CanRename = false };
    }

    /// <summary>A text edit over <paramref name="span"/>.</summary>
    public static TextEditResult Edit(LinePositionSpan span, string newText)
    {
        return new TextEditResult
        {
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character,
            NewText = newText,
        };
    }

    private static CompletionItem? MapCompletion(CompletionItem item, RazorProjection origin)
    {
        return item.TextEdit is null ? item
            : MapEdit(item.TextEdit, origin) is { } edit
                ? new CompletionItem
                {
                    Label = item.Label,
                    Kind = item.Kind,
                    Detail = item.Detail,
                    InsertText = item.InsertText,
                    Index = item.Index,
                    TextEdit = edit,
                }
            : null;
    }

    private static PrepareRenameResult Prepared(LinePositionSpan span, string placeholder)
    {
        return new PrepareRenameResult
        {
            CanRename = true,
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character,
            Placeholder = placeholder,
        };
    }

    private static LinePositionSpan SpanOf(TextEditResult edit)
    {
        return new LinePositionSpan(
            new LinePosition(edit.StartLine, edit.StartCharacter),
            new LinePosition(edit.EndLine, edit.EndCharacter)
        );
    }
}
