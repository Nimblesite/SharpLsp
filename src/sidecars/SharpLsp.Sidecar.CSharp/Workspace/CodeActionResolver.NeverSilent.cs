using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using Serilog;
using SharpLsp.Sidecar.Common;
using ResolveResult = Outcome.Result<SharpLsp.Sidecar.CSharp.WorkspaceEditResult, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// The resolve half of the code-action pipeline. A resolve that cannot produce
/// the action's change FAILS with a reason in plain words and is logged at
/// <c>Warning</c> with the action's title — never an empty or partial edit the
/// editor would apply as a silent no-op. Implements [REFACTOR-NEVER-SILENT].
/// </summary>
internal sealed partial class CodeActionResolver
{
    /// <summary>
    /// The reason an unknown or already-consumed action id fails: the action was
    /// offered against a document state that no longer exists. [REFACTOR-NEVER-SILENT]
    /// </summary>
    internal const string StaleActionReason =
        "the code action is no longer available: the document changed after it was offered; "
        + "invoke the quick fix again";

    /// <summary>
    /// Resolve a previously cached code action by ID, returning workspace edits.
    /// </summary>
    public async Task<ResolveResult> ResolveAsync(
        int actionId,
        Solution originalSolution,
        CancellationToken ct
    )
    {
        if (!_pendingActions.TryRemove(actionId, out var codeAction))
        {
            return ActionFailure($"action {actionId}", StaleActionReason);
        }

        var operations = await codeAction.GetOperationsAsync(ct).ConfigureAwait(false);
        var applyOp = operations.OfType<ApplyChangesOperation>().FirstOrDefault();
        return applyOp is null
            ? EmptyEditFailure(codeAction.Title)
            : await ResolveChangesAsync(codeAction.Title, originalSolution, applyOp, ct)
                .ConfigureAwait(false);
    }

    private static async Task<ResolveResult> ResolveChangesAsync(
        string title,
        Solution originalSolution,
        ApplyChangesOperation applyOp,
        CancellationToken ct
    )
    {
        if (UnexpressedByEdit(originalSolution, applyOp.ChangedSolution) is { } what)
        {
            return ActionFailure(
                title,
                $"the action '{title}' would {what}, which a code action edit cannot apply"
            );
        }

        var edit = await BuildWorkspaceEditAsync(originalSolution, applyOp.ChangedSolution, ct)
            .ConfigureAwait(false);
        return edit.DocumentChanges.Count == 0
            ? EmptyEditFailure(title)
            : new ResolveResult.Ok<WorkspaceEditResult, string>(edit);
    }

    private static ResolveResult EmptyEditFailure(string title)
    {
        return ActionFailure(title, $"Code action \"{title}\" produced no changes");
    }

    private static ResolveResult ActionFailure(string? title, string reason)
    {
        // [REFACTOR-NEVER-SILENT]: the selected action must explain an empty resolve.
        Log.Warning("[CodeAction] Resolve failed {Title} {Reason}", title, reason);
        return ResolveResult.Failure(reason);
    }

    private static async Task CollectAddedDocumentsAsync(
        Solution newSolution,
        ProjectChanges projectChange,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        foreach (var docId in projectChange.GetAddedDocuments())
        {
            await CollectAddedDocumentAsync(newSolution, docId, result, ct).ConfigureAwait(false);
        }
    }

    private static async Task CollectAddedDocumentAsync(
        Solution solution,
        DocumentId docId,
        WorkspaceEditResult result,
        CancellationToken ct
    )
    {
        var document = solution.GetDocument(docId);
        var path = document is null ? null : AddedDocumentPath(document);
        if (path is null)
        {
            // Unreachable in practice: [REFACTOR-NEVER-SILENT] refuses the whole
            // resolve earlier, in UnexpressedByEdit, when a path cannot be placed.
            return;
        }

        var text = await document!.GetTextAsync(ct).ConfigureAwait(false);
        result.DocumentChanges.Add(CreateAddedDocumentEdit(path, text.ToString()));
    }

    /// <summary>
    /// The path an added document lands at: its own when it has one, else the path
    /// the project would give it, under the project directory and its folders —
    /// so "Generate class 'X' in new file" creates the file instead of vanishing.
    /// [REFACTOR-NEVER-SILENT]
    /// </summary>
    private static string? AddedDocumentPath(Document document)
    {
        if (document.FilePath is { } own)
        {
            return own;
        }

        var projectFile = document.Project.FilePath;
        return projectFile is null
            ? null
            : NativePaths.Join([
                NativePaths.DirectoryOf(projectFile),
                .. document.Folders,
                document.Name,
            ]);
    }

    private static DocumentEditResult CreateAddedDocumentEdit(string filePath, string text)
    {
        return new DocumentEditResult
        {
            FilePath = filePath,
            Edits = [CreateWholeDocumentEdit(text)],
            Create = true,
        };
    }

    private static TextEditResult CreateWholeDocumentEdit(string text)
    {
        return new TextEditResult
        {
            StartLine = 0,
            StartCharacter = 0,
            EndLine = 0,
            EndCharacter = 0,
            NewText = text,
        };
    }

    /// <summary>
    /// Every change a text-edit workspace edit cannot express, in plain words:
    /// project, metadata and analyzer references (which go through
    /// [REFACTOR-IMPORT-REFERENCE] instead), added or removed projects, removed
    /// documents, and documents whose path is unknown. `null` when the edit can
    /// express everything. [REFACTOR-NEVER-SILENT]
    /// </summary>
    private static string? UnexpressedByEdit(Solution oldSolution, Solution newSolution)
    {
        var changes = newSolution.GetChanges(oldSolution);
        return UnexpressedProjects(changes, oldSolution, newSolution)
            ?? UnexpressedReferences(changes, newSolution);
    }

    private static string? UnexpressedProjects(
        SolutionChanges changes,
        Solution oldSolution,
        Solution newSolution
    )
    {
        var described = changes
            .GetAddedProjects()
            .Select(project => $"add the project '{project.Name}'")
            .Concat(
                changes
                    .GetRemovedProjects()
                    .Select(project => $"remove the project '{project.Name}'")
            )
            .Concat(
                changes
                    .GetProjectChanges()
                    .SelectMany(change => RemovedDocuments(change, oldSolution))
            )
            .Concat(
                changes
                    .GetProjectChanges()
                    .SelectMany(change => UnplaceableAdded(change, newSolution))
            )
            .Concat(
                changes
                    .GetProjectChanges()
                    .SelectMany(change => UnplaceableChanged(change, oldSolution, newSolution))
            )
            .Concat(
                changes
                    .GetAddedAnalyzerReferences()
                    .Select(reference => $"add the analyzer '{reference.Display}'")
            )
            .Concat(
                changes
                    .GetRemovedAnalyzerReferences()
                    .Select(reference => $"remove the analyzer '{reference.Display}'")
            )
            .ToList();
        return described.Count == 0 ? null : string.Join("; ", described);
    }

    private static IEnumerable<string> RemovedDocuments(ProjectChanges change, Solution oldSolution)
    {
        return change
            .GetRemovedDocuments()
            .Select(docId => $"remove the document '{DocumentName(oldSolution, docId)}'");
    }

    private static string? UnexpressedReferences(SolutionChanges changes, Solution newSolution)
    {
        var described = changes
            .GetProjectChanges()
            .SelectMany(change => DescribedReferences(change, newSolution))
            .ToList();
        return described.Count == 0 ? null : string.Join("; ", described);
    }

    private static IEnumerable<string> DescribedReferences(
        ProjectChanges change,
        Solution newSolution
    )
    {
        foreach (var reference in change.GetAddedProjectReferences())
        {
            yield return $"add a reference to project '{ProjectName(newSolution, reference.ProjectId)}'";
        }
        foreach (var reference in change.GetRemovedProjectReferences())
        {
            yield return $"remove the reference to project '{ProjectName(newSolution, reference.ProjectId)}'";
        }
        foreach (var reference in change.GetAddedMetadataReferences())
        {
            yield return $"add the reference '{reference.Display}'";
        }
        foreach (var reference in change.GetRemovedMetadataReferences())
        {
            yield return $"remove the reference '{reference.Display}'";
        }
        foreach (var reference in change.GetAddedAnalyzerReferences())
        {
            yield return $"add the analyzer '{reference.Display}'";
        }
        foreach (var reference in change.GetRemovedAnalyzerReferences())
        {
            yield return $"remove the analyzer '{reference.Display}'";
        }
    }

    /// <summary>
    /// Added documents that cannot be placed anywhere: the edit would silently
    /// drop them otherwise. [REFACTOR-NEVER-SILENT]
    /// </summary>
    private static IEnumerable<string> UnplaceableAdded(ProjectChanges change, Solution newSolution)
    {
        return change
            .GetAddedDocuments()
            .Select(docId => newSolution.GetDocument(docId))
            .Where(document => document is null || AddedDocumentPath(document) is null)
            .Select(document =>
                $"add a new document '{document?.Name ?? "unknown"}' whose file path is unknown"
            );
    }

    /// <summary>
    /// Changed documents whose path is unknown: the edit would silently drop
    /// them otherwise. [REFACTOR-NEVER-SILENT]
    /// </summary>
    private static IEnumerable<string> UnplaceableChanged(
        ProjectChanges change,
        Solution oldSolution,
        Solution newSolution
    )
    {
        return change
            .GetChangedDocuments()
            .Where(docId =>
                oldSolution.GetDocument(docId)?.FilePath is null
                || newSolution.GetDocument(docId)?.FilePath is null
            )
            .Select(_ => "change a document whose file path is unknown");
    }

    private static string ProjectName(Solution solution, ProjectId projectId)
    {
        return solution.GetProject(projectId)?.Name ?? projectId.ToString();
    }

    private static string DocumentName(Solution solution, DocumentId docId)
    {
        return solution.GetDocument(docId)?.Name ?? docId.ToString();
    }
}
