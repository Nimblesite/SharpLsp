using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeActions;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>End-to-end coverage for [REFACTOR-MOVE-TYPE-RENAME-FILE].</summary>
public sealed class RenameFileTests : IDisposable
{
    private const string Wrong = "Wrong.cs";
    private const string Matching = "Matching.cs";

    private static readonly IReadOnlyDictionary<string, string> Files = new Dictionary<string, string>(
        StringComparer.Ordinal
    )
    {
        [Wrong] = "public class Lone { }\n",
        [Matching] = "public class Matching { }\n",
    };

    private readonly RefactoringProject _project = new("RenameFile", Files);

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task Rename_file_resolves_to_the_old_and_new_paths_without_text_edits()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, Wrong, "public class Lone { }", "Lone");
        var action = actions.Find(item => item.Title == "Rename file to Lone.cs");

        Assert.NotNull(action);
        Assert.Equal("refactor.rewrite", action.Kind);

        var resolved = await manager.ResolveCodeActionAsync(action.Id);
        var edit = RefactoringProject.Unwrap(resolved);
        var change = Assert.Single(edit.DocumentChanges);

        Assert.True(NativePaths.AreEqual(_project.PathOf(Wrong), change.FilePath), change.FilePath);
        Assert.True(NativePaths.AreEqual(_project.PathOf("Lone.cs"), change.RenameTo), change.RenameTo);
        Assert.False(change.Create);
        Assert.Empty(change.Edits);
    }

    [Fact]
    public async Task An_action_whose_solution_has_no_changes_fails_with_its_title()
    {
        using var workspace = new AdhocWorkspace();
        var solution = workspace.CurrentSolution;
        var resolver = new CodeActionResolver();
        var action = CodeAction.Create("Do nothing", _ => Task.FromResult(solution));
        var cached = resolver.CacheAction(action, "refactor.rewrite", action.Title);

        var resolved = await resolver.ResolveAsync(cached.Id, solution, CancellationToken.None);

        Assert.True(resolved.IsError);
        var reason = resolved.Match(_ => "", error => error);
        Assert.Contains("Do nothing", reason, StringComparison.Ordinal);
        Assert.Contains("no changes", reason, StringComparison.Ordinal);
        Assert.Equal(cached.Title, action.Title);
    }

    [Fact]
    public async Task Rename_file_is_not_offered_when_the_file_name_already_matches_the_type()
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(
            manager,
            Matching,
            "public class Matching { }",
            "Matching"
        );

        Assert.NotEmpty(actions);
        Assert.DoesNotContain(actions, action => action.Title.StartsWith("Rename file to ", StringComparison.Ordinal));
        Assert.Contains(actions, action => action.Title.Contains("Matching", StringComparison.Ordinal));
    }
}
