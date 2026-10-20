using Microsoft.AspNetCore.Razor.Language;
using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.CSharp.Workspace;

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
        return DocumentPosition.ToDiagnostic(
            new FileLinePositionSpan(
                filePath,
                markup.Text.Lines.GetLinePositionSpan(diagnostic.Span)
            ),
            diagnostic.Id,
            diagnostic.Severity == RazorDiagnosticSeverity.Error ? "Error" : "Warning",
            diagnostic.Message
        );
    }
}
