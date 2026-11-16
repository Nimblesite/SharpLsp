using Microsoft.CodeAnalysis.CodeActions;

namespace SharpLsp.Sidecar.CSharp.Workspace;

// The caching half of the action listing: every offered Roslyn CodeAction is
// keyed for a later resolve, flattened from its nested actions, de-duplicated,
// and — when its provider supports it — stamped with its fix-all identity
// ([FIXALL-SCOPES], GitHub #577). Split from CodeActionResolver.cs so neither
// file grows past the size budget.

internal sealed partial class CodeActionResolver
{
    private void CacheAndAdd(
        CodeAction action,
        string kind,
        List<CodeActionItem> items,
        string? parentTitle,
        FixAllCapability? fixAll = null
    )
    {
        var title = Qualified(parentTitle, action.Title);
        // An action with options needs an IDE dialog a headless host cannot show, and
        // its options service does not exist here, so resolving it throws. It is never
        // offered: Roslyn's own "Generate overrides..." has a headless replacement, and
        // the rest wait for one. [REFACTOR-NO-DIALOG] (GitHub #201)
        if (
            action is CodeActionWithOptions
            || CacheNestedActions(action, kind, items, title)
            || IsDuplicate(title, kind, items)
        )
        {
            return;
        }

        items.Add(CacheAction(action, kind, title, fixAll));
    }

    private bool CacheNestedActions(
        CodeAction action,
        string kind,
        List<CodeActionItem> items,
        string title
    )
    {
        if (action.NestedActions.IsEmpty)
        {
            return false;
        }

        foreach (var nested in action.NestedActions)
        {
            CacheAndAdd(nested, kind, items, title);
        }

        return true;
    }

    /// <summary>
    /// A flattened child's title, carrying the container it came from when it
    /// cannot stand without it.
    /// </summary>
    /// <remarks>
    /// LSP has no submenus, so a nested action arrives in the same flat list as
    /// every other and its title is all the user reads before choosing. Roslyn
    /// writes children in two shapes: sentences that name themselves ("Inline
    /// and keep 'X'", "Convert to binary") and continuations of the PARENT's
    /// sentence ("and update call sites directly", "into new overload") that say
    /// nothing alone. Only the continuations are joined, and with a space, so
    /// the result reads as the sentence Roslyn actually wrote. Renaming the
    /// self-contained ones would only make them stutter.
    /// </remarks>
    private static string Qualified(string? parentTitle, string title)
    {
        return string.IsNullOrEmpty(parentTitle) || !IsContinuation(title)
            ? title
            : parentTitle + " " + title;
    }

    /// <summary>
    /// Whether a child's title continues its parent's sentence instead of
    /// naming itself. Roslyn writes those in lower case, and only those.
    /// </summary>
    private static bool IsContinuation(string title)
    {
        return title.Length > 0 && char.IsLower(title[0]);
    }

    private static bool IsDuplicate(string title, string kind, List<CodeActionItem> items)
    {
        return items.Any(item => item.Title == title && item.Kind == kind);
    }

    internal CodeActionItem CacheAction(
        CodeAction action,
        string kind,
        string title,
        FixAllCapability? fixAll = null
    )
    {
        var id = Interlocked.Increment(ref _nextId);
        _pendingActions[id] = action;
        if (fixAll is not null)
        {
            // The fix-all behind the key, so a later resolve runs its own provider.
            _fixAllProviders[fixAll.FixKey] = fixAll;
        }
        return new CodeActionItem(
            Id: id,
            Title: title,
            Kind: kind,
            IsPreferred: action.Priority == CodeActionPriority.High,
            Reference: null,
            FixKey: fixAll?.FixKey,
            FixAllScopes: fixAll is null ? null : [.. fixAll.Scopes]
        );
    }
}
