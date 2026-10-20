using Microsoft.AspNetCore.Razor.Language;

namespace SharpLsp.Sidecar.CSharp.Razor;

/// <summary>
/// A Razor file's own (<c>RZ</c>) diagnostics as the file's diagnostics report them: the
/// compiler's span, with Razor's error severity as Error and its warning severity as Warning.
/// Implements [RAZOR-FEATURES-DIAGNOSTICS].
/// </summary>
internal static class RazorMarkupDiagnostics
{
    public static IEnumerable<DiagnosticResult> Of(string filePath, RazorMarkup? markup)
    {
        return markup is null
            ? []
            : markup.Diagnostics.Select(diagnostic => Result(filePath, markup, diagnostic));
    }

    private static DiagnosticResult Result(
        string filePath,
        RazorMarkup markup,
        MarkupDiagnostic diagnostic
    )
    {
        var span = markup.Text.Lines.GetLinePositionSpan(diagnostic.Span);
        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = span.Start.Line,
            StartCharacter = span.Start.Character,
            EndLine = span.End.Line,
            EndCharacter = span.End.Character,
            Message = diagnostic.Message,
            Severity = diagnostic.Severity == RazorDiagnosticSeverity.Error ? "Error" : "Warning",
            Code = diagnostic.Id,
        };
    }
}
