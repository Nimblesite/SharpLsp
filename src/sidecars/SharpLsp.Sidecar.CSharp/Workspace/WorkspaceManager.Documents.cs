using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.Common.Messages;
using DocumentsResult = Outcome.Result<
    System.Collections.Generic.List<SharpLsp.Sidecar.Common.Messages.DiagnosticDocument>,
    string
>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>
/// <c>workspace/diagnostics/documents</c>: every user source and Razor document of
/// the current solution with its owning project. A pure enumeration of the live
/// snapshot — no eager compilation and no result caches ([DIAG-ARCHITECTURE-EAGER-SCAN]).
/// </summary>
internal sealed partial class WorkspaceManager
{
    /// <summary>
    /// Every document of the loaded solution; empty before a workspace loads. The
    /// Solution reference is atomically swapped under the mutation lock, so one
    /// read is a consistent immutable snapshot — no lock needed to enumerate it.
    /// </summary>
    public Task<DocumentsResult> GetDocumentsAsync(CancellationToken ct = default)
    {
        try
        {
            ct.ThrowIfCancellationRequested();
            return Task.FromResult(EnumerateDocuments());
        }
        catch (Exception ex)
        {
            return Task.FromResult(DocumentsResult.Failure(ex.Message));
        }
    }

    private DocumentsResult EnumerateDocuments()
    {
        // Read-modify-write races aside, the immutable Solution reference itself is
        // atomically swapped, so one read is a consistent snapshot.
        var solution = _solution;
        if (solution is null)
        {
            return new DocumentsResult.Ok<List<DiagnosticDocument>, string>([]);
        }

        var documents = new List<DiagnosticDocument>();
        // One path identity per entry, by the same rule that decides path equality
        // everywhere else in the sidecars ([SHARPLSP-ARCHITECTURE-PATHS]).
        var seen = new HashSet<string>(NativePaths.Comparer);

        foreach (var project in solution.Projects)
        {
            if (project.FilePath is null)
            {
                continue;
            }

            foreach (var document in project.Documents)
            {
                AddDocument(documents, seen, project, project.FilePath, document.FilePath);
            }

            foreach (var razor in project.AdditionalDocuments)
            {
                if (razor.FilePath is not null && NativePaths.IsRazor(razor.FilePath))
                {
                    AddDocument(documents, seen, project, project.FilePath, razor.FilePath);
                }
            }
        }

        return new DocumentsResult.Ok<List<DiagnosticDocument>, string>(documents);
    }

    /// <summary>
    /// Add a document with its owner, once per path: a multi-targeted project and a
    /// shared linked file appear once. Generated build output under <c>obj</c> or
    /// <c>bin</c> is never user source — a valid linked source outside them stays.
    /// </summary>
    private static void AddDocument(
        List<DiagnosticDocument> documents,
        HashSet<string> seen,
        Project project,
        string projectPath,
        string? filePath
    )
    {
        if (
            filePath is null
            || filePath.Length == 0
            || NativePaths.HasDirectory(filePath, "obj")
            || NativePaths.HasDirectory(filePath, "bin")
        )
        {
            return;
        }

        if (!seen.Add(filePath))
        {
            return;
        }

        documents.Add(
            new DiagnosticDocument
            {
                FilePath = filePath,
                ProjectName = project.Name,
                ProjectPath = projectPath,
            }
        );
    }
}
