using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A completion's additional edits, moved from a projection into its Razor file: an edit
/// inside one C# fragment maps across, an added C# <c>using</c> becomes an <c>@using</c> line
/// after the file's own, and anything else cannot be placed and is dropped.
/// Implements [RAZOR-ARCHITECTURE-PROJECTION] and [RAZOR-FEATURES-COMPLETION].
/// </summary>
internal static class RazorCompletionEdits
{
    /// <summary>The Razor edits for <paramref name="changes"/> computed on <paramref name="origin"/>'s projection.</summary>
    public static IEnumerable<TextEditResult> Map(
        RazorProjection origin,
        IEnumerable<TextChange> changes
    )
    {
        var existing = OwnUsings(origin).Select(Spelling).ToHashSet(StringComparer.Ordinal);
        foreach (var change in changes)
        {
            if (origin.Map.ToRazor(change.Span) is { } span)
            {
                yield return DocumentText.ToTextEdit(
                    origin.RazorText,
                    new TextChange(span, change.NewText ?? "")
                );
                continue;
            }

            foreach (var added in AddedUsings(change).Where(existing.Add))
            {
                yield return UsingLine(origin, added);
            }
        }
    }

    /// <summary>The using directives a change inserts: its whole text parses as usings and nothing else.</summary>
    private static IEnumerable<string> AddedUsings(TextChange change)
    {
        var unit = SyntaxFactory.ParseCompilationUnit(change.NewText ?? "");
        return unit.ContainsDiagnostics || unit.Members.Count > 0 || unit.AttributeLists.Count > 0
            ? []
            : unit.Usings.Select(Spelling);
    }

    /// <summary>The usings this Razor file declares itself, as its projection carries them.</summary>
    private static IEnumerable<UsingDirectiveSyntax> OwnUsings(RazorProjection origin)
    {
        return origin
            .GeneratedRoot.DescendantNodes()
            .OfType<UsingDirectiveSyntax>()
            .Where(directive => IsOwn(origin, directive));
    }

    private static bool IsOwn(RazorProjection origin, UsingDirectiveSyntax directive)
    {
        var mapped = directive.NamespaceOrType.GetLocation().GetMappedLineSpan();
        return mapped.HasMappedPath && NativePaths.AreEqual(mapped.Path, origin.RazorPath);
    }

    /// <summary>A using directive as Razor spells it after <c>@using</c>.</summary>
    private static string Spelling(UsingDirectiveSyntax directive)
    {
        var isStatic =
            directive.StaticKeyword.RawKind == (int)SyntaxKind.StaticKeyword ? "static " : "";
        var alias = directive.Alias is { } named ? named.Name.Identifier.ValueText + " = " : "";
        return isStatic + alias + directive.NamespaceOrType.ToString();
    }

    /// <summary>An <c>@using</c> line inserted after the file's last own using, else at its start.</summary>
    private static TextEditResult UsingLine(RazorProjection origin, string spelling)
    {
        var after = OwnUsings(origin)
            .Select(directive => directive.NamespaceOrType.GetLocation().GetMappedLineSpan())
            .Select(span => span.EndLinePosition.Line + 1)
            .DefaultIfEmpty(0)
            .Max();
        var line = Math.Min(after, origin.RazorText.Lines.Count - 1);
        var at = origin.RazorText.Lines[line].Start;
        var text = "@using " + spelling + LineBreak(origin.RazorText);
        return DocumentText.ToTextEdit(origin.RazorText, new TextChange(new TextSpan(at, 0), text));
    }

    private static string LineBreak(SourceText text)
    {
        var first = text.Lines[0];
        return first.SpanIncludingLineBreak.Length > first.Span.Length
            ? text.ToString(TextSpan.FromBounds(first.End, first.EndIncludingLineBreak))
            : "\n";
    }
}
