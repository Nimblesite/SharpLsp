using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

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

    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
            <Nullable>enable</Nullable>
          </PropertyGroup>
        </Project>
        """;

    private readonly ProjectlessWorkspaceFixture _files = new("generate-ctor");
    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public GenerateConstructorFromMembersTests()
    {
        _csprojPath = _files.Write("Generating.csproj", Csproj);
        _sourcePath = _files.Write("Target.cs", Source);
    }

    public void Dispose()
    {
        _files.Dispose();
    }

    [Fact]
    public async Task A_selection_over_two_fields_offers_a_constructor_taking_both()
    {
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, _csprojPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        var (startLine, startCharacter) = Locate("private readonly int _count;");
        var (endLine, endCharacter) = Locate("private readonly string _label;");
        endCharacter += "private readonly string _label;".Length;
        var result = await manager.GetCodeActionsAsync(
            _sourcePath,
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
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, _csprojPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        var (line, character) = Locate("public class Target");
        character += "public class ".Length;
        var result = await manager.GetCodeActionsAsync(
            _sourcePath,
            line,
            character,
            line,
            character
        );
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));

        var titles = (+result).Select(action => action.Title).ToList();
        Assert.Contains("Generate constructor 'Target()'", titles);
    }

    /// <summary>Zero-based line and column where <paramref name="snippet"/> starts.</summary>
    private static (int Line, int Character) Locate(string snippet)
    {
        var lines = Source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var line = Array.FindIndex(lines, value => value.Contains(snippet));
        Assert.True(line >= 0, $"snippet not found: <{snippet}>");
        return (line, lines[line].IndexOf(snippet, StringComparison.Ordinal));
    }
}
