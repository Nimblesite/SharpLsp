using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Razor;
using HoverQueryResult = Outcome.Result<SharpLsp.Sidecar.CSharp.HoverResult?, string>;
using ImplementationsResult = Outcome.Result<SharpLsp.Sidecar.CSharp.LocationListResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Features on Blazor markup, answered from the compiler's markup facts where no C# fragment
/// answers. Implements [RAZOR-FEATURES-HOVER] and [RAZOR-FEATURES-DEFINITION].
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// The hover on the markup name at a position of a Razor file: a component tag, attribute
    /// or directive; null anywhere else.
    /// </summary>
    private Task<HoverQueryResult> MarkupHoverAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return RunQueryAsync(
            () => Task.FromResult(FindRazorDocument(filePath)),
            null,
            async razor =>
                await MarkupAtAsync(razor, line, character, ct).ConfigureAwait(false) is { } at
                    ? RazorMarkupHover.At(at.Markup, at.Compilation, at.Offset)
                    : null
        );
    }

    /// <summary>
    /// The definition of the markup name at a position of a Razor file: a component's files,
    /// or the parameter property an attribute sets; none anywhere else.
    /// </summary>
    private Task<ImplementationsResult> MarkupDefinitionAsync(
        string filePath,
        int line,
        int character,
        CancellationToken ct
    )
    {
        return RunQueryAsync(
            () => Task.FromResult(FindRazorDocument(filePath)),
            new LocationListResult(),
            async razor =>
                await MarkupAtAsync(razor, line, character, ct).ConfigureAwait(false) is { } at
                && RazorMarkupSymbols.At(at.Compilation, at.Markup, at.Offset) is { } named
                    ? await MapLocationsAsync(
                            await DefinitionResolver
                                .LocationsOfAsync(razor.Project, named.Symbol, ct)
                                .ConfigureAwait(false),
                            ct
                        )
                        .ConfigureAwait(false)
                    : new LocationListResult()
        );
    }

    /// <summary>
    /// The completion items markup adds at a position of a Razor file: the directives where an
    /// <c>@</c> opens a markup line, and where C# answered nothing, components, parameters and
    /// directive attributes. [RAZOR-FEATURES-COMPLETION]
    /// </summary>
    private async Task<List<CompletionItem>> MarkupCompletionsAsync(
        string filePath,
        (int Line, int Character) caret,
        bool csharpAnswered,
        CancellationToken ct
    )
    {
        var razor = FindRazorDocument(filePath);
        var at = razor is null
            ? null
            : await MarkupAtAsync(razor, caret.Line, caret.Character, ct).ConfigureAwait(false);
        if (at is not { } found)
        {
            return [];
        }

        var markup = csharpAnswered
            ? null
            : RazorMarkupCompletion.At(found.Markup, found.Compilation, found.Offset);
        return [.. RazorMarkupCompletion.Directives(found.Markup, found.Offset), .. markup ?? []];
    }

    /// <summary>What a markup query at a position works on: the facts, the compilation, the offset.</summary>
    private static async Task<(
        RazorMarkup Markup,
        Compilation Compilation,
        int Offset
    )?> MarkupAtAsync(TextDocument razor, int line, int character, CancellationToken ct)
    {
        var markup = await RazorMarkupEngine.ProcessAsync(razor, ct).ConfigureAwait(false);
        var compilation = await razor.Project.GetCompilationAsync(ct).ConfigureAwait(false);
        var offset = markup is null
            ? null
            : DocumentText.TryOffset(markup.Text, new LinePosition(line, character));
        return markup is null || compilation is null || offset is null
            ? null
            : (markup, compilation, offset.Value);
    }
}
