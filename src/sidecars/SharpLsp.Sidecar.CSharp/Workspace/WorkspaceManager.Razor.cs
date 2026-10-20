using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using Serilog;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Where a position query runs: a document, the position in it, and the Razor file the
/// request named when the document is that file's projection.
/// </summary>
internal sealed record QueryTarget(
    Document Document,
    int Line,
    int Character,
    RazorProjection? Origin
)
{
    /// <summary>The file the answer belongs to: the Razor file, else the document itself.</summary>
    public string AnswerPath => Origin?.RazorPath ?? Document.FilePath ?? "";
}

/// <summary>
/// Razor files in the workspace: their text, and position queries translated into their C#
/// projections. Implements [RAZOR-ARCHITECTURE-DOCUMENTS] and [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>The projection of the Razor file at <paramref name="razorPath"/> in its active framework.</summary>
    internal async Task<RazorProjection?> FindRazorProjectionAsync(
        string razorPath,
        CancellationToken ct
    )
    {
        var razor = FindRazorDocument(razorPath);
        return razor is null
            ? null
            : await RazorProjection.ForRazorAsync(razor, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The markup facts of the Razor file at <paramref name="razorPath"/>; null when no project
    /// lists it or the engine cannot read it. [RAZOR-ARCHITECTURE-ENGINE]
    /// </summary>
    internal async Task<RazorMarkup?> FindRazorMarkupAsync(string razorPath, CancellationToken ct)
    {
        var razor = FindRazorDocument(razorPath);
        return razor is null
            ? null
            : await RazorMarkupEngine.ProcessAsync(razor, ct).ConfigureAwait(false);
    }

    /// <summary>The Razor file at <paramref name="razorPath"/> in its active framework; null when no project lists it.</summary>
    internal TextDocument? FindRazorDocument(string razorPath)
    {
        return _solution is null
            ? null
            : TargetFrameworks.FindActiveAdditionalDocument(
                _solution,
                razorPath,
                _activeFrameworks
            );
    }

    /// <summary>
    /// Run <paramref name="query"/> where the position lands: the document itself, or, for a
    /// Razor file, its projection at the mapped position. A position outside every C#
    /// fragment, or a file outside the workspace, answers <paramref name="empty"/>.
    /// </summary>
    private Task<Outcome.Result<T, string>> RunPositionQueryAsync<T>(
        string filePath,
        (int Line, int Character) at,
        T empty,
        Func<QueryTarget, Task<T>> query,
        CancellationToken ct
    )
    {
        return RunQueryAsync(() => ResolveQueryTargetAsync(filePath, at, ct), empty, query);
    }

    private async Task<QueryTarget?> ResolveQueryTargetAsync(
        string filePath,
        (int Line, int Character) at,
        CancellationToken ct
    )
    {
        if (!NativePaths.IsRazor(filePath))
        {
            var document = await FindDocumentAsync(filePath, ct).ConfigureAwait(false);
            return document is null ? null : new QueryTarget(document, at.Line, at.Character, null);
        }

        var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
        return projection is null
            ? null
            : Target(projection, new LinePosition(at.Line, at.Character));
    }

    /// <summary>Where a query at <paramref name="position"/> in a Razor file runs in its projection.</summary>
    private static QueryTarget? Target(RazorProjection projection, LinePosition position)
    {
        return projection.ToGenerated(position) is { } mapped
            ? new QueryTarget(projection.Generated, mapped.Line, mapped.Character, projection)
            : null;
    }

    /// <summary>
    /// Where completion runs: where any position query runs, except in a Razor expression the
    /// compiler cannot finish yet, where it runs in a copy that finishes it. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    private async Task<QueryTarget?> ResolveCompletionTargetAsync(
        string filePath,
        (int Line, int Character) at,
        CancellationToken ct
    )
    {
        if (!NativePaths.IsRazor(filePath))
        {
            return await ResolveQueryTargetAsync(filePath, at, ct).ConfigureAwait(false);
        }

        var position = new LinePosition(at.Line, at.Character);
        var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
        return projection is null
            ? null
            : Target(await FinishedAsync(projection, position, ct).ConfigureAwait(false), position);
    }

    /// <summary>
    /// <paramref name="projection"/>, or, when <paramref name="position"/> is in an expression the
    /// compiler cannot finish yet, the projection of a copy of the file that finishes it. A copy
    /// that does not map the caret leaves the file's own projection to answer.
    /// </summary>
    private static async Task<RazorProjection> FinishedAsync(
        RazorProjection projection,
        LinePosition position,
        CancellationToken ct
    )
    {
        var insertions = DocumentText.TryOffset(projection.RazorText, position) is { } caret
            ? await RazorCompletionRecovery
                .FinishAsync(projection, caret, () => MarkupDiagnosticsAsync(projection, ct))
                .ConfigureAwait(false)
            : [];
        var finished = insertions.IsEmpty
            ? null
            : await CopyFinishingAsync(projection, insertions, ct).ConfigureAwait(false);
        return finished?.ToGenerated(position) is null ? projection : finished;
    }

    /// <summary>The Razor compiler's diagnostics for <paramref name="projection"/>'s file.</summary>
    private static async Task<IEnumerable<MarkupDiagnostic>> MarkupDiagnosticsAsync(
        RazorProjection projection,
        CancellationToken ct
    )
    {
        var markup = await RazorMarkupEngine
            .ProcessAsync(projection.Razor, ct)
            .ConfigureAwait(false);
        return markup?.Diagnostics ?? [];
    }

    /// <summary>
    /// The projection of a copy of <paramref name="projection"/>'s file, in its active framework,
    /// with <paramref name="insertions"/> made, read in the file itself; null when the copy
    /// projects nothing.
    /// </summary>
    private static async Task<RazorProjection?> CopyFinishingAsync(
        RazorProjection projection,
        ImmutableArray<TextChange> insertions,
        CancellationToken ct
    )
    {
        var copy = projection.Razor.Project.Solution.WithAdditionalDocumentText(
            projection.Razor.Id,
            projection.RazorText.WithChanges(insertions)
        );
        var finished = copy.GetAdditionalDocument(projection.Razor.Id) is { } razor
            ? await RazorProjection.ForRazorAsync(razor, ct).ConfigureAwait(false)
            : null;
        Log.Debug(
            "[Completion] Razor expression finished in a copy {File} {Insertions} {Projected}",
            projection.RazorPath,
            insertions.Length,
            finished is not null
        );
        return finished?.ReadIn(projection, insertions);
    }

    /// <summary>
    /// Replace a Razor file's text in every framework context. Caller holds
    /// <see cref="_solutionMutationLock"/>. A file no project lists has nothing to update.
    /// </summary>
    private void UpdateRazorText(string filePath, string newText)
    {
        _solution = TargetFrameworks.WithAdditionalTextInEveryContext(
            _solution!,
            filePath,
            SourceText.From(newText)
        );
    }

    /// <summary>
    /// A Razor file's diagnostics: its projection's C# diagnostics that map into it.
    /// [RAZOR-FEATURES-DIAGNOSTICS]
    /// </summary>
    private async Task<List<DiagnosticResult>> DiagnoseRazorAsync(
        string filePath,
        CancellationToken ct
    )
    {
        var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
        var model = projection is null
            ? null
            : await projection.Generated.GetSemanticModelAsync(ct).ConfigureAwait(false);
        return model is null ? [] : MapDiagnostics(filePath, model, ct);
    }

    /// <summary>
    /// A Razor file's semantic tokens, all of them or those that start in
    /// <paramref name="range"/>. [RAZOR-FEATURES-SEMANTIC-TOKENS]
    /// </summary>
    private Task<Outcome.Result<SemanticTokensResult, string>> GetRazorSemanticTokensAsync(
        string filePath,
        LinePositionSpan? range,
        CancellationToken ct
    )
    {
        return RunQueryAsync(
            () => FindRazorProjectionAsync(filePath, ct),
            new SemanticTokensResult(),
            async projection => new SemanticTokensResult
            {
                Data = await RazorTokensAsync(projection, range, ct).ConfigureAwait(false),
            }
        );
    }

    private static async Task<int[]> RazorTokensAsync(
        RazorProjection projection,
        LinePositionSpan? range,
        CancellationToken ct
    )
    {
        var text = projection.RazorText;
        var window = range is { } requested ? DocumentText.TrySpan(text, requested) : null;
        var spans = await RazorSemanticTokens
            .CSharpSpansAsync(projection, ct)
            .ConfigureAwait(false);
        return SemanticTokensResolver.Encode(
            spans
                .Where(span => window is not { } inside || inside.Contains(span.Span.Start))
                .Where(span => span.Type >= 0)
                .DistinctBy(span => span.Span.Start),
            text
        );
    }

    /// <summary><paramref name="result"/> with projection locations mapped to Razor files or dropped.</summary>
    private Task<LocationListResult> MapLocationsAsync(
        LocationListResult result,
        CancellationToken ct
    )
    {
        return _solution is null
            ? Task.FromResult(result)
            : RazorLocations.MapAsync(_solution, result, ct);
    }

    /// <summary>
    /// The location <paramref name="resolve"/> finds where the position lands, mapped to a
    /// Razor file, or null when it is hidden scaffolding. [RAZOR-FEATURES-DEFINITION]
    /// </summary>
    private Task<Outcome.Result<LocationResult?, string>> RunLocationQueryAsync(
        string filePath,
        (int Line, int Character) at,
        Func<Document, int, int, CancellationToken, Task<LocationResult?>> resolve,
        CancellationToken ct
    )
    {
        return RunPositionQueryAsync<LocationResult?>(
            filePath,
            at,
            null,
            async target =>
                await MapLocationAsync(
                        await resolve(target.Document, target.Line, target.Character, ct)
                            .ConfigureAwait(false),
                        ct
                    )
                    .ConfigureAwait(false),
            ct
        );
    }

    /// <summary><paramref name="location"/> mapped to a Razor file, or null when it is hidden scaffolding.</summary>
    private async Task<LocationResult?> MapLocationAsync(
        LocationResult? location,
        CancellationToken ct
    )
    {
        return _solution is null
            ? location
            : await RazorLocations.MapAsync(_solution, location, ct).ConfigureAwait(false);
    }
}
