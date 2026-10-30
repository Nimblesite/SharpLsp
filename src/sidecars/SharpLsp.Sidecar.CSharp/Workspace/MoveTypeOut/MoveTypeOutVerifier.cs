using Microsoft.CodeAnalysis;

namespace SharpLsp.Sidecar.CSharp.Workspace.MoveTypeOut;

/// <summary>
/// The safety net under [REFACTOR-MOVE-TYPE-REFUSED]: a move the preconditions let
/// through must still compile. Every project the move changed is compiled, and the
/// first error that was not there before fails the resolve with its message
/// ([REFACTOR-NEVER-SILENT]).
/// </summary>
internal static class MoveTypeOutVerifier
{
    public static async Task AssertCompilesAsync(
        MoveTypeOutTarget target,
        Solution before,
        Solution after,
        CancellationToken ct
    )
    {
        foreach (var change in after.GetChanges(before).GetProjectChanges())
        {
            var introduced = await FirstNewErrorAsync(change.OldProject, change.NewProject, ct)
                .ConfigureAwait(false);
            if (introduced is not null)
            {
                throw new InvalidOperationException($"{target.FailurePrefix} {Describe(introduced)}");
            }
        }
    }

    private static async Task<Diagnostic?> FirstNewErrorAsync(
        Project before,
        Project after,
        CancellationToken ct
    )
    {
        var known = (await ErrorsAsync(before, ct).ConfigureAwait(false))
            .Select(Key)
            .ToHashSet(StringComparer.Ordinal);
        return (await ErrorsAsync(after, ct).ConfigureAwait(false)).FirstOrDefault(error =>
            !known.Contains(Key(error))
        );
    }

    private static async Task<IReadOnlyList<Diagnostic>> ErrorsAsync(
        Project project,
        CancellationToken ct
    )
    {
        var compilation = await project.GetCompilationAsync(ct).ConfigureAwait(false);
        return compilation is null
            ? []
            : compilation
                .GetDiagnostics(ct)
                .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                .ToList();
    }

    /// <summary>An error's identity without its position, which the move shifts.</summary>
    private static string Key(Diagnostic diagnostic)
    {
        return diagnostic.Id + " " + diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static string Describe(Diagnostic diagnostic)
    {
        var line = diagnostic.Location.GetLineSpan();
        var file = line.Path is null ? "" : $" ({Common.NativePaths.NameOf(line.Path)}:{line.StartLinePosition.Line + 1})";
        return $"{diagnostic.Id}: {diagnostic.GetMessage(System.Globalization.CultureInfo.InvariantCulture)}{file}";
    }
}
