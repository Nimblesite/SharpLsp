using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

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

    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-merge-{Guid.NewGuid():N}"
    );

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public MergeDeclarationAssignmentTests()
    {
        Directory.CreateDirectory(_root);
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
                <Nullable>enable</Nullable>
              </PropertyGroup>
            </Project>
            """;
        _csprojPath = Path.Combine(_root, "Merging.csproj");
        _sourcePath = Path.Combine(_root, "Merging.cs");
        File.WriteAllText(_csprojPath, csproj);
        File.WriteAllText(_sourcePath, Source);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task Merging_from_the_declaration_folds_the_assignment_into_the_initializer()
    {
        using var manager = await OpenAsync();
        var merged = await ApplyAtAsync(manager, "        int total;", "int");

        Assert.Contains("int total = 41 + 1;", merged);
        // The standalone assignment statement must be gone, not merely duplicated
        // into the initializer — a substring check would pass either way.
        Assert.DoesNotContain(Statements(merged), statement => statement == "total = 41 + 1;");
        AssertStillCompiles(merged);
    }

    [Fact]
    public async Task Merging_from_the_assignment_line_finds_the_declaration_above_it()
    {
        using var manager = await OpenAsync();
        var merged = await ApplyAtAsync(manager, "        value = 7;", "value");

        Assert.Contains("int value = 7;", merged);
        AssertStillCompiles(merged);
    }

    [Fact]
    public async Task Merging_works_inside_a_switch_section_not_only_a_block()
    {
        using var manager = await OpenAsync();
        var merged = await ApplyAtAsync(manager, "                int inner;", "int");

        Assert.Contains("int inner = 2;", merged);
        AssertStillCompiles(merged);
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
        using var manager = await OpenAsync();
        var actions = await ActionsAtAsync(manager, anchor, token);

        Assert.DoesNotContain(actions, action => action.Title == Title);
    }

    /// <summary>Apply the merge at <paramref name="anchor"/> and return the new file text.</summary>
    private async Task<string> ApplyAtAsync(WorkspaceManager manager, string anchor, string token)
    {
        var actions = await ActionsAtAsync(manager, anchor, token);
        var action = actions.Find(item => item.Title == Title);
        Assert.NotNull(action);

        var edit = Unwrap(await manager.ResolveCodeActionAsync(action.Id));
        var document = Assert.Single(edit.DocumentChanges);
        Assert.Equal(_sourcePath, document.FilePath);
        Assert.NotEmpty(document.Edits);
        return ApplyEdits(Source, document.Edits);
    }

    private async Task<List<CodeActionItem>> ActionsAtAsync(
        WorkspaceManager manager,
        string anchor,
        string token
    )
    {
        var (line, character) = Locate(anchor, token);
        return Unwrap(
            await manager.GetCodeActionsAsync(_sourcePath, line, character, line, character)
        );
    }

    /// <summary>Every line of <paramref name="text"/> trimmed, for whole-statement assertions.</summary>
    private static IEnumerable<string> Statements(string text)
    {
        return text.Split('\n').Select(line => line.Trim());
    }

    /// <summary>The merged file must still parse; a malformed rewrite is the failure hunted here.</summary>
    private static void AssertStillCompiles(string merged)
    {
        var errors = Microsoft
            .CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(merged)
            .GetDiagnostics()
            .Where(diagnostic =>
                diagnostic.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error
            )
            .Select(diagnostic => diagnostic.ToString())
            .ToList();
        Assert.Empty(errors);
    }

    /// <summary>Zero-based line/character of <paramref name="token"/> on the anchor line.</summary>
    private static (int Line, int Character) Locate(string anchor, string token)
    {
        var lines = Source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var index = Array.FindIndex(lines, value => value == anchor);
        Assert.True(index >= 0, $"anchor line not found verbatim: <{anchor}>");
        var character = lines[index].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"token not found on anchor line: {token}");
        return (index, character);
    }

    private async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
        var opened = await manager.OpenAsync(_csprojPath);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded for code actions");
        return manager;
    }

    private static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    private static string ApplyEdits(string source, IEnumerable<TextEditResult> edits)
    {
        var text = SourceText.From(source);
        var changes = edits.Select(edit => new TextChange(EditSpan(text, edit), edit.NewText));
        return text.WithChanges(changes).ToString();
    }

    private static TextSpan EditSpan(SourceText text, TextEditResult edit)
    {
        var start = text.Lines.GetPosition(new LinePosition(edit.StartLine, edit.StartCharacter));
        var end = text.Lines.GetPosition(new LinePosition(edit.EndLine, edit.EndCharacter));
        return TextSpan.FromBounds(start, end);
    }
}
