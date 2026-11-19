using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A name Roslyn reports as simplifiable (IDE0001, IDE0002) offers the fix that simplifies it:
/// a diagnostic the developer is shown must come with its remedy. [REFACTOR-NEVER-SILENT]
/// </summary>
public sealed class SimplifyNameFixTests : IAsyncLifetime, IDisposable
{
    private const string Source = """
        using System;
        using System.Text;

        namespace Simplify;

        public static class Names
        {
            public static System.Text.StringBuilder Describe(System.Text.StringBuilder builder)
            {
                System.Console.WriteLine(builder.Length);
                return builder;
            }
        }

        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-simplify-{Guid.NewGuid():N}");
    private readonly WorkspaceManager _manager = new();
    private string SourcePath => NativePaths.Join(_root, "Names.cs");

    public async Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        var project = NativePaths.Join(_root, "Simplify.csproj");
        await File.WriteAllTextAsync(
                project,
                "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>"
            )
            .ConfigureAwait(false);
        await File.WriteAllTextAsync(SourcePath, Source).ConfigureAwait(false);
        // The rules are promoted, as this repository's own .editorconfig promotes them: the
        // report then shows each name, and the fix must be there with it.
        await File.WriteAllTextAsync(
                NativePaths.Join(_root, ".editorconfig"),
                "root = true\n[*.cs]\ndotnet_diagnostic.IDE0001.severity = warning\ndotnet_diagnostic.IDE0002.severity = warning\n"
            )
            .ConfigureAwait(false);
        var opened = await ProjectlessWorkspaceFixture
            .OpenAsync(_manager, project)
            .ConfigureAwait(false);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
    }

    public Task DisposeAsync()
    {
        Dispose();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _manager.Dispose();
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, true);
        }
    }

    /// <summary>The titles offered over <paramref name="text"/> inside its first <paramref name="marker"/>.</summary>
    private async Task<List<string>> TitlesAtAsync(string marker, string text)
    {
        return
        [
            .. (await ActionsAtAsync(marker, text).ConfigureAwait(false)).Select(action =>
                action.Title
            ),
        ];
    }

    /// <summary>The actions offered over <paramref name="text"/> inside its first <paramref name="marker"/>.</summary>
    private async Task<List<CodeActionItem>> ActionsAtAsync(string marker, string text)
    {
        var offset =
            Source.IndexOf(marker, StringComparison.Ordinal)
            + marker.IndexOf(text, StringComparison.Ordinal);
        var lines = SourceText.From(Source).Lines;
        var (start, end) = (
            lines.GetLinePosition(offset),
            lines.GetLinePosition(offset + text.Length)
        );
        var result = await _manager
            .GetCodeActionsAsync(SourcePath, start.Line, start.Character, end.Line, end.Character)
            .ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return result.Match(value => value, _ => []);
    }

    [Fact]
    public async Task A_simplifiable_name_offers_its_simplification()
    {
        // The report shows the promoted rules on this file: there is something to fix.
        var reported = await ProjectlessWorkspaceFixture.DiagnosticsAsync(_manager, SourcePath);
        Assert.Contains(reported, diagnostic => diagnostic.Code == "IDE0001");
        Assert.Contains(reported, diagnostic => diagnostic.Code == "IDE0002");

        // Interaction 1 — a qualified return type whose namespace is imported.
        var type = await TitlesAtAsync(
            "public static System.Text.StringBuilder Describe",
            "System.Text"
        );
        Assert.Contains(type, title => title.Contains("Simplify name", StringComparison.Ordinal));

        // Interaction 2 — the same name as a parameter type: each occurrence has its own fix.
        var parameter = await TitlesAtAsync("(System.Text.StringBuilder builder", "System.Text");
        Assert.Contains(parameter, title =>
            title.Contains("Simplify name", StringComparison.Ordinal)
        );

        // Interaction 3 — a qualified member access (IDE0002).
        var member = await TitlesAtAsync("System.Console.WriteLine", "System");
        Assert.Contains(member, title => title.Contains("Simplify", StringComparison.Ordinal));

        // Interaction 4 — resolving the fix removes exactly the qualifier, and nothing else.
        var offered = await ActionsAtAsync(
            "public static System.Text.StringBuilder Describe",
            "System.Text"
        );
        var simplify = offered.First(action =>
            action.Title.Contains("Simplify name", StringComparison.Ordinal)
        );
        var resolved = await _manager.ResolveCodeActionAsync(simplify.Id);
        Assert.False(resolved.IsError, resolved.Match(_ => "ok", error => error));
        var change = Assert.Single((+resolved).DocumentChanges);
        Assert.Equal(
            Source.Replace(
                "public static System.Text.StringBuilder Describe",
                "public static StringBuilder Describe"
            ),
            TextEditing.ApplyEdits(Source, change.Edits)
        );

        // Interaction 5 — a name with nothing to simplify offers no such fix.
        var plain = await TitlesAtAsync("return builder;", "builder");
        Assert.DoesNotContain(plain, title => title.Contains("Simplify", StringComparison.Ordinal));
    }
}
