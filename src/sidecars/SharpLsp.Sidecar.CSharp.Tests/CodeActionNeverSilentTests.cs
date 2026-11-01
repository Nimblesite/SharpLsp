using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;
using static SharpLsp.Sidecar.CSharp.Tests.TextEditing;

// Implements [REFACTOR-NEVER-SILENT]: an action the user chose either makes its
// change or tells the user it did not, why, and that the details are in the log.
// No resolve may return an empty or partial edit.

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A resolve that cannot produce the action's change must FAIL with a reason in
/// plain words — never an empty edit the editor would apply as a silent no-op
/// ([REFACTOR-NEVER-SILENT]). Every test drives the real resolver against a real
/// restored MSBuild project and asserts the exact reason text.
/// </summary>
public sealed class CodeActionNeverSilentTests : IDisposable
{
    /// <summary>The exact reason for an unknown or already-consumed action id.</summary>
    private const string StaleReason =
        "the code action is no longer available: the document changed after it was offered; "
        + "invoke the quick fix again";

    /// <summary>A source whose only error is the unresolved <c>Widget</c> (CS0246).</summary>
    private const string Source = """
        namespace App;

        public class Probe
        {
            public Widget Make() => new Widget();
        }
        """;

    private readonly string _root = NativePaths.Temp($"sharplsp-never-silent-{Guid.NewGuid():N}");

    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public CodeActionNeverSilentTests()
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
        _csprojPath = NativePaths.Join(_root, "App.csproj");
        _sourcePath = NativePaths.Join(_root, "Probe.cs");
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

    // ── Interaction 1: a bogus id names its cause in plain words ──

    [Fact]
    public async Task Resolving_an_unknown_id_fails_with_the_exact_reason()
    {
        using var manager = await OpenLoadedAsync();
        var resolved = await manager.ResolveCodeActionAsync(999_999);

        Assert.True(resolved.IsError, "an unknown id must fail, not resolve to an edit");
        Assert.Equal(StaleReason, ErrorOf(resolved));
    }

    // ── Interaction 2: an id can be consumed exactly once ──

    [Fact]
    public async Task Resolving_the_same_id_twice_fails_the_second_time()
    {
        using var manager = await OpenLoadedAsync();
        var offered = await QuickFixesOnWidgetAsync(manager);
        Assert.NotEmpty(offered);

        var first = await manager.ResolveCodeActionAsync(offered[0].Id);
        Assert.False(first.IsError, $"the first resolve must succeed: {ErrorOfTyped(first)}");

        var second = await manager.ResolveCodeActionAsync(offered[0].Id);
        Assert.True(second.IsError, "the same id must not resolve twice");
        Assert.Equal(StaleReason, ErrorOfTyped(second));
    }

    // ── Interaction 3: "Generate class … in new file" creates the file ──

    [Fact]
    public async Task Generate_class_in_new_file_resolves_to_a_create_edit_at_the_project_path()
    {
        using var manager = await OpenLoadedAsync();
        var offered = await QuickFixesOnWidgetAsync(manager);
        var generate = offered.Find(action =>
            action.Title.Contains("Generate class", StringComparison.Ordinal)
            && action.Title.Contains("new file", StringComparison.Ordinal)
        );
        Assert.True(
            generate is not null,
            $"a generate-class action must be offered: {Titles(offered)}"
        );

        var edit = OkOf(await manager.ResolveCodeActionAsync(generate.Id));
        var created = Assert.Single(edit.DocumentChanges);
        Assert.True(created.Create, "the edit must create the new file");
        Assert.Equal(NativePaths.Join(_root, "Widget.cs"), created.FilePath);

        var text = ApplyEdits(string.Empty, created.Edits);
        Assert.Contains("class Widget", text);

        await AssertCs0246DisappearsOnceTheFileExistsAsync(text);
    }

    // ── Interaction 4: no offered fix may resolve to an empty edit ──

    [Fact]
    public async Task Every_offered_quick_fix_resolves_to_changes_or_a_failure()
    {
        using var manager = await OpenLoadedAsync();
        var offered = await QuickFixesOnWidgetAsync(manager);
        Assert.NotEmpty(offered);

        foreach (var action in offered)
        {
            var resolved = await manager.ResolveCodeActionAsync(action.Id);
            Assert.False(
                !resolved.IsError && OkOf(resolved).DocumentChanges.Count == 0,
                $"'{action.Title}' resolved to an EMPTY edit — it must carry changes or fail with a reason"
            );
        }
    }

    /// <summary>
    /// The user story behind the create edit: the file lands on disk, the project is
    /// reloaded, and the CS0246 the fix was offered for is gone.
    /// </summary>
    private async Task AssertCs0246DisappearsOnceTheFileExistsAsync(string generatedText)
    {
        await File.WriteAllTextAsync(NativePaths.Join(_root, "Widget.cs"), generatedText);
        using var reloaded = await OpenLoadedAsync();
        var diagnostics = OkOf(await reloaded.GetDiagnosticsAsync(_sourcePath));
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS0246");
    }

    private async Task<WorkspaceManager> OpenLoadedAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
        var opened = await manager.OpenAsync(_csprojPath);
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded to resolve actions");
        return manager;
    }

    private async Task<List<CodeActionItem>> QuickFixesOnWidgetAsync(WorkspaceManager manager)
    {
        var result = await manager.GetCodeActionsAsync(_sourcePath, 4, 32, 4, 38);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return [.. +result];
    }

    private static string ErrorOf(Outcome.Result<WorkspaceEditResult, string> result)
    {
        return ErrorOfTyped(result);
    }

    private static string ErrorOfTyped<T>(Outcome.Result<T, string> result)
    {
        return result.Match(_ => string.Empty, error => error);
    }

    private static T OkOf<T>(Outcome.Result<T, string> result)
    {
        Assert.False(result.IsError, ErrorOfTyped(result));
        return +result;
    }

    private static string Titles(IEnumerable<CodeActionItem> actions)
    {
        return string.Join("; ", actions.Select(action => $"'{action.Title}'"));
    }
}
