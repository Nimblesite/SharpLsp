using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for "Merge declaration and assignment"
/// ([SHARPLSP-FEATURES-REFACTORING]).
///
/// The refactoring was never applied by any test, so the whole rewriting half —
/// building the initializer, carrying the assignment operator's trivia across,
/// and deleting the assignment statement — ran zero times. A provider that
/// emitted uncompilable C#, or that offered itself on a declaration it must not
/// touch, would have shipped unnoticed. These tests drive the real
/// WorkspaceManager against a real MSBuild project and assert on the C# it
/// returns, and pin the shapes the provider must refuse.
/// </summary>
public sealed class MergeDeclarationAssignmentTests : IDisposable
{
    private const string Title = "Merge declaration and assignment";

    private const string Source = """
        namespace Merging;

        public class Merger
        {
            private int _field;

            public int FromDeclaration()
            {
                int total;
                total = 41 + 1;
                return total;
            }

            public int FromAssignment()
            {
                int value;
                value = 7;
                return value;
            }

            public int InSwitch(int input)
            {
                switch (input)
                {
                    case 1:
                        int inner;
                        inner = 2;
                        return inner;
                    default:
                        return 0;
                }
            }

            public int AlreadyInitialized()
            {
                int seeded = 1;
                seeded = 2;
                return seeded;
            }

            public int TwoVariables()
            {
                int first, second;
                first = 1;
                second = 2;
                return first + second;
            }

            public int CommentBetween()
            {
                int spaced;
                // Keeping this comment matters more than merging.
                spaced = 3;
                return spaced;
            }

            public int TargetsAField()
            {
                int unrelated;
                _field = 4;
                unrelated = _field;
                return unrelated;
            }

            public void TrailingDeclaration()
            {
                int dangling;
            }
        }
        """;

    private readonly RefactoringProject _project =
        new("Merging", new Dictionary<string, string> { ["Merging.cs"] = Source });

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task Merging_from_the_declaration_folds_the_assignment_into_the_initializer()
    {
        using var manager = await _project.OpenAsync();
        var merged = await ApplyAtAsync(manager, "        int total;", "int");

        Assert.Contains("int total = 41 + 1;", merged);
        // The standalone assignment statement must be gone, not merely duplicated
        // into the initializer — a substring check would pass either way.
        Assert.DoesNotContain(Statements(merged), statement => statement == "total = 41 + 1;");
        Assert.Empty(RefactoringProject.ParseErrors(merged));
    }

    [Fact]
    public async Task Merging_from_the_assignment_line_finds_the_declaration_above_it()
    {
        using var manager = await _project.OpenAsync();
        var merged = await ApplyAtAsync(manager, "        value = 7;", "value");

        Assert.Contains("int value = 7;", merged);
        Assert.Empty(RefactoringProject.ParseErrors(merged));
    }

    [Fact]
    public async Task Merging_works_inside_a_switch_section_not_only_a_block()
    {
        using var manager = await _project.OpenAsync();
        var merged = await ApplyAtAsync(manager, "                int inner;", "int");

        Assert.Contains("int inner = 2;", merged);
        Assert.Empty(RefactoringProject.ParseErrors(merged));
    }

    [Theory]
    // An initialized declaration has nothing to fold the assignment into.
    [InlineData("        int seeded = 1;", "int")]
    // Two declarators would have to be split before either could be merged.
    [InlineData("        int first, second;", "int")]
    // Merging past a comment would silently relocate or drop it.
    [InlineData("        int spaced;", "int")]
    // The following assignment writes a field, not the declared local.
    [InlineData("        int unrelated;", "int")]
    // Nothing follows the declaration at all.
    [InlineData("        int dangling;", "int")]
    public async Task The_refactoring_is_refused_where_merging_would_change_behaviour(
        string anchor,
        string token
    )
    {
        using var manager = await _project.OpenAsync();
        var actions = await _project.ActionsAtAsync(manager, "Merging.cs", anchor, token);

        Assert.DoesNotContain(actions, action => action.Title == Title);
    }

    /// <summary>Apply the merge at <paramref name="anchor"/> and return the new file text.</summary>
    private async Task<string> ApplyAtAsync(WorkspaceManager manager, string anchor, string token)
    {
        var edit = await _project.ApplyAsync(manager, "Merging.cs", anchor, token, Title);
        var document = Assert.Single(edit.DocumentChanges);
        Assert.Equal(_project.PathOf("Merging.cs"), document.FilePath);
        Assert.NotEmpty(document.Edits);
        return _project.After(edit, "Merging.cs");
    }

    /// <summary>Every line of <paramref name="text"/> trimmed, for whole-statement assertions.</summary>
    private static IEnumerable<string> Statements(string text)
    {
        return text.Split('\n').Select(line => line.Trim());
    }
}
