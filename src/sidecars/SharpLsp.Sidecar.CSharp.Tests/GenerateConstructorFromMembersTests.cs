#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// "Generate constructor" seeded from the members the user SELECTED
/// ([SHARPLSP-FEATURES-REFACTORING], P0). Roslyn's provider reads the
/// selection to decide which fields the constructor takes; a selection over
/// two fields that yields no constructor at all is the refactoring missing,
/// not the user selecting wrongly.
/// </summary>
public sealed class GenerateConstructorFromMembersTests : IDisposable
{
    private const string Source = """
        namespace Generating;

        public class Target
        {
            private readonly int _count;
            private readonly string _label;

            public string Describe() => $"{_label}:{_count}";
        }
        """;

    private readonly RefactoringProject _project =
        new("Generating", new Dictionary<string, string> { ["Target.cs"] = Source });

    public void Dispose()
    {
        _project.Dispose();
    }

    [Fact]
    public async Task A_selection_over_two_fields_offers_a_constructor_taking_both()
    {
        using var manager = await _project.OpenAsync();

        var (startLine, startCharacter) = RefactoringProject.Locate(
            Source,
            "    private readonly int _count;",
            "private"
        );
        var (endLine, endCharacter) = RefactoringProject.Locate(
            Source,
            "    private readonly string _label;",
            "private"
        );
        endCharacter += "private readonly string _label;".Length;
        var result = await manager.GetCodeActionsAsync(
            _project.PathOf("Target.cs"),
            startLine,
            startCharacter,
            endLine,
            endCharacter
        );
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var actions = +result;

        var titles = actions.Select(action => action.Title).ToList();
        Assert.True(
            titles.Contains("Generate constructor 'Target(int count, string label)'"),
            "offered: " + string.Join(" | ", titles)
        );
    }

    [Fact]
    public async Task A_caret_on_the_type_name_offers_the_parameterless_constructor()
    {
        using var manager = await _project.OpenAsync();

        var (line, character) = RefactoringProject.Locate(
            Source,
            "public class Target",
            "public"
        );
        character += "public class ".Length;
        var result = await manager.GetCodeActionsAsync(
            _project.PathOf("Target.cs"),
            line,
            character,
            line,
            character
        );
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));

        var titles = (+result).Select(action => action.Title).ToList();
        Assert.Contains("Generate constructor 'Target()'", titles);
    }
}
