using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xUnit requires the public partial test class.
// RS1035: these end-to-end tests deliberately exercise real files and real MSBuild state.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed partial class FileBasedPackageSpecEndToEndTests
{
    private static readonly TimeSpan Debounce = TimeSpan.FromMilliseconds(400);

    private static string PackageApp(string version, int value)
    {
        return $"#:package Newtonsoft.Json@{version}\nusing Newtonsoft.Json;\n"
            + $"Console.WriteLine(JsonConvert.SerializeObject({value}));\n";
    }

    /// <summary>
    /// A directive is typed one keystroke at a time. Only the directive set left standing when
    /// the debounce window closes is restored, a text-only edit never restores, and the app
    /// binds against the package throughout. Implements [SCRIPT-RELOAD].
    /// </summary>
    [Fact]
    public async Task Directive_edits_restore_once_after_the_debounce_and_text_edits_never_do()
    {
        var app = _fixture.Write("Debounced.cs", PackageApp("13.0.1", 1));
        _ = PrepareRestoreRoot(app);
        var json = new HoverProbe(app, 2, 20, "Newtonsoft.Json.JsonConvert");
        using var manager = new WorkspaceManager { DirectiveReloadDebounce = Debounce };
        AssertSucceeded(await ProjectlessWorkspaceFixture.OpenAsync(manager, app));
        _ = await WaitHoverAsync(manager, json);
        await AwaitStatusAsync(manager, "loaded");
        Assert.Equal(1, manager.PackageRestores);

        // 1. Text-only edits: the directive set is unchanged, so nothing is restored.
        foreach (var value in new[] { 2, 3, 4 })
        {
            AssertSucceeded(
                await manager.UpdateDocumentTextAsync(app, PackageApp("13.0.1", value))
            );
        }
        await Task.Delay(Debounce * 2);
        Assert.Equal(1, manager.PackageRestores);
        _ = await WaitHoverAsync(manager, json);
        Assert.Equal("loaded", manager.Status);

        // 2. A version retyped keystroke by keystroke, each inside the window: one restore,
        //    of the version left standing, and none of the half-typed ones.
        foreach (var typed in new[] { "13.0.", "13.0", "13.0.", "13.0.2", "13.0.", "13.0.3" })
        {
            AssertSucceeded(await manager.UpdateDocumentTextAsync(app, PackageApp(typed, 4)));
        }
        Assert.Equal(1, manager.PackageRestores);
        _ = await WaitHoverAsync(manager, json);
        await AwaitStatusAsync(manager, "loaded");
        Assert.Equal(2, manager.PackageRestores);
        var settled = await DiagnosticsAsync(manager, app);
        Assert.DoesNotContain(settled, diagnostic => diagnostic.Code == DegradationCode);
        Assert.Empty(Errors(settled));

        // 3. A directive edit after the window has closed is its own reload.
        AssertSucceeded(await manager.UpdateDocumentTextAsync(app, PackageApp("13.0.1", 4)));
        _ = await WaitHoverAsync(manager, json);
        await AwaitStatusAsync(manager, "loaded");
        Assert.Equal(3, manager.PackageRestores);
        Assert.Empty(Errors(await DiagnosticsAsync(manager, app)));
    }
}
