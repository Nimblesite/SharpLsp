using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A real MSBuild project in a temp folder, opened by a real <see cref="WorkspaceManager"/>,
/// for tests that apply a code action and read the files it produces. One instance per
/// test class; the folder is deleted with it.
/// </summary>
internal sealed class RefactoringProject : IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
            <Nullable>enable</Nullable>
          </PropertyGroup>
        </Project>
        """;

    private readonly Dictionary<string, string> _sources = new(StringComparer.Ordinal);

    public RefactoringProject(string name, IReadOnlyDictionary<string, string> files)
    {
        Root = NativePaths.Temp($"sharplsp-{name}-{Guid.NewGuid():N}");
        _ = Directory.CreateDirectory(Root);
        CsprojPath = NativePaths.Join(Root, $"{name}.csproj");
        File.WriteAllText(CsprojPath, Csproj);
        foreach (var (fileName, source) in files)
        {
            var path = NativePaths.Join(Root, fileName);
            File.WriteAllText(path, source);
            _sources[path] = source;
        }
    }

    public string Root { get; }

    public string CsprojPath { get; }

    /// <summary>The absolute path of <paramref name="fileName"/> in the project.</summary>
    public string PathOf(string fileName)
    {
        return NativePaths.Join(Root, fileName);
    }

    /// <summary>The text <paramref name="fileName"/> was written with.</summary>
    public string SourceOf(string fileName)
    {
        return _sources[PathOf(fileName)];
    }

    public async Task<WorkspaceManager> OpenAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
        var opened = await manager.OpenAsync(CsprojPath);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded for code actions");
        return manager;
    }

    /// <summary>The code actions at <paramref name="token"/> on the line equal to <paramref name="anchor"/>.</summary>
    public async Task<List<CodeActionItem>> ActionsAtAsync(
        WorkspaceManager manager,
        string fileName,
        string anchor,
        string token
    )
    {
        var (line, character) = Locate(SourceOf(fileName), anchor, token);
        var path = PathOf(fileName);
        return Unwrap(await manager.GetCodeActionsAsync(path, line, character, line, character));
    }

    /// <summary>Apply the action titled <paramref name="title"/> there, and return its edit.</summary>
    public async Task<WorkspaceEditResult> ApplyAsync(
        WorkspaceManager manager,
        string fileName,
        string anchor,
        string token,
        string title
    )
    {
        var actions = await ActionsAtAsync(manager, fileName, anchor, token);
        var action = actions.Find(item => item.Title == title);
        Assert.NotNull(action);
        return Unwrap(await manager.ResolveCodeActionAsync(action.Id));
    }

    /// <summary>The text of <paramref name="fileName"/> once <paramref name="edit"/> is applied to it.</summary>
    public string After(WorkspaceEditResult edit, string fileName)
    {
        var change = edit.DocumentChanges.Find(document =>
            NativePaths.AreEqual(document.FilePath, PathOf(fileName))
        );
        Assert.NotNull(change);
        return change.Create
            ? Assert.Single(change.Edits).NewText
            : TextEditing.ApplyEdits(SourceOf(fileName), change.Edits);
    }

    /// <summary>The C# parse errors in <paramref name="text"/>: a malformed rewrite is the failure hunted.</summary>
    public static IReadOnlyList<string> ParseErrors(string text)
    {
        return
        [
            .. CSharpSyntaxTree
                .ParseText(text)
                .GetDiagnostics()
                .Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                .Select(diagnostic => diagnostic.ToString()),
        ];
    }

    /// <summary>Zero-based line/character of <paramref name="token"/> on the line equal to <paramref name="anchor"/>.</summary>
    public static (int Line, int Character) Locate(string source, string anchor, string token)
    {
        var lines = source.Split('\n').Select(line => line.TrimEnd('\r')).ToArray();
        var index = Array.FindIndex(lines, value => value == anchor);
        Assert.True(index >= 0, $"anchor line not found verbatim: <{anchor}>");
        var character = lines[index].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"token not found on anchor line: {token}");
        return (index, character);
    }

    public static T Unwrap<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, true);
        }
        catch (IOException) { }
    }
}
