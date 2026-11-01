using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Options-style Roslyn refactorings must still resolve to their edits in the
/// headless sidecar. A failure must be real and explained, never invented for a
/// change the workspace edit can express. [SHARPLSP-FEATURES-REFACTORING]
/// [REFACTOR-NEVER-SILENT]
/// </summary>
public sealed class OptionsRefactoringResolveTests : IDisposable
{
    private const string CountField = "    private readonly int _count;";
    private const string LabelField = "    private readonly string _label;";

    private const string Source = """
        namespace Generating;

        public class Target
        {
            private readonly int _count;
            private readonly string _label;

            public string Describe() => $"{_label}:{_count}";
        }
        """;

    private readonly RefactoringProject _project = new(
        "Generating",
        new Dictionary<string, string> { ["Target.cs"] = Source }
    );

    [Fact]
    public async Task Generate_constructor_from_selected_fields_resolves_to_the_seeded_constructor()
    {
        using var manager = await _project.OpenAsync();
        var actions = await SelectedFieldActionsAsync(manager);
        var action = actions.Find(item =>
            item.Title == "Generate constructor 'Target(int count, string label)'"
        );
        Assert.NotNull(action);

        var edit = RefactoringProject.Unwrap(await manager.ResolveCodeActionAsync(action.Id));
        var text = _project.After(edit, "Target.cs");
        Assert.Contains("public Target(int count, string label)", text, StringComparison.Ordinal);
        Assert.Contains("_count = count;", text, StringComparison.Ordinal);
        Assert.Contains("_label = label;", text, StringComparison.Ordinal);
    }

    private async Task<List<CodeActionItem>> SelectedFieldActionsAsync(WorkspaceManager manager)
    {
        var (startLine, startCharacter) = RefactoringProject.Locate(Source, CountField, "private");
        var (endLine, endCharacter) = RefactoringProject.Locate(Source, LabelField, "private");
        endCharacter += LabelField.TrimStart().Length;
        return RefactoringProject.Unwrap(
            await manager.GetCodeActionsAsync(
                _project.PathOf("Target.cs"),
                startLine,
                startCharacter,
                endLine,
                endCharacter
            )
        );
    }

    public void Dispose()
    {
        _project.Dispose();
    }
}
