using System.Collections.Immutable;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;
using CodeActionsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.CSharp.CodeActionItem>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// Razor code actions: quick fixes for C# names the projection cannot bind, and refactorings
/// that move a block or elements into a new file. Each is offered with its edit computed, under
/// a negative id so it never meets a Roslyn action's; a new request replaces the last offers.
/// Implements [RAZOR-CODE-ACTIONS].
/// </summary>
internal sealed partial class WorkspaceManager
{
    private ImmutableDictionary<int, WorkspaceEditResult> _razorActions = [];

    private int _lastRazorAction;

    /// <summary>The Razor file's code actions at <paramref name="range"/>; none for a file no project lists.</summary>
    private Task<CodeActionsResult> GetRazorCodeActionsAsync(
        string filePath,
        LinePositionSpan range,
        CancellationToken ct
    )
    {
        _razorActions = [];
        return RunQueryAsync(
            async () =>
            {
                var projection = await FindRazorProjectionAsync(filePath, ct).ConfigureAwait(false);
                var markup = await FindRazorMarkupAsync(filePath, ct).ConfigureAwait(false);
                return projection is null || markup is null
                    ? null
                    : new RazorFile(projection, markup);
            },
            new List<CodeActionItem>(),
            async found =>
                Offer(
                    await RazorActionsAsync(found.Projection, found.Markup, range, ct)
                        .ConfigureAwait(false)
                )
        );
    }

    /// <summary>A Razor file's projection and markup facts, which its code actions read.</summary>
    private sealed record RazorFile(RazorProjection Projection, RazorMarkup Markup);

    private static async Task<IEnumerable<RazorCodeAction>> RazorActionsAsync(
        RazorProjection projection,
        RazorMarkup markup,
        LinePositionSpan range,
        CancellationToken ct
    )
    {
        var span = markup.Text.Lines.GetTextSpan(range);
        var model =
            await projection.Generated.GetSemanticModelAsync(ct).ConfigureAwait(false)
            ?? throw new InvalidOperationException("The projection has no semantic model");
        var fixes = await RazorQuickFixes
            .ForAsync(projection, markup, span, ct)
            .ConfigureAwait(false);
        RazorCodeAction?[] refactorings =
        [
            RazorExtractActions.CodeBehind(projection, markup, model.Compilation, span.Start),
            RazorExtractActions.Component(projection, markup, model, span),
        ];
        return fixes.Concat(refactorings.OfType<RazorCodeAction>());
    }

    /// <summary>Offer <paramref name="actions"/> in place of the last ones offered.</summary>
    private List<CodeActionItem> Offer(IEnumerable<RazorCodeAction> actions)
    {
        var offered = actions
            .Select(action => (Id: Interlocked.Decrement(ref _lastRazorAction), Action: action))
            .ToList();
        _razorActions = offered.ToImmutableDictionary(
            entry => entry.Id,
            entry => entry.Action.Edit
        );
        return
        [
            .. offered.Select(entry => new CodeActionItem
            {
                Id = entry.Id,
                Title = entry.Action.Title,
                Kind = entry.Action.Kind,
                IsPreferred = entry.Action.IsPreferred,
            }),
        ];
    }

    /// <summary>The edit of a Razor action offered last; null for any other id.</summary>
    private WorkspaceEditResult? ResolveRazorAction(int actionId)
    {
        return _razorActions.GetValueOrDefault(actionId);
    }

    /// <summary>Whether <paramref name="actionId"/> names a Razor action: Roslyn's ids count up from one.</summary>
    private static bool IsRazorAction(int actionId)
    {
        return actionId < 0;
    }

    /// <summary>Whether a code action request is for a Razor file.</summary>
    private static bool IsRazorRequest(string filePath)
    {
        return NativePaths.IsRazor(filePath);
    }
}
