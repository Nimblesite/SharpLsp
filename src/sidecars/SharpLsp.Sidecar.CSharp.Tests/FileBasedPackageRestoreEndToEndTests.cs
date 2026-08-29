using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// End-to-end coverage for the .NET file-based app project model — <c>#:package</c> restore,
/// <c>#:include</c> closure edits and reopening a root — driven through the real
/// <see cref="WorkspaceManager"/> against real files on disk.
///
/// Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD], [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
/// and [SCRIPT-DEGRADE]. The resolver synthesizes an MSBuild project, shells out to
/// <c>dotnet restore</c> and re-opens the restored project to harvest its metadata references.
/// Every one of those steps can fail in a way the editor must survive, so what is asserted here
/// is the observable outcome: whether the package API binds, and whether a failed restore
/// surfaces the tier-2 degradation notice instead of a wall of phantom errors.
/// </summary>
public sealed class FileBasedPackageRestoreEndToEndTests : IDisposable
{
    private readonly ProjectlessWorkspaceFixture _fixture = new("pkg");

    public void Dispose()
    {
        _fixture.Dispose();
    }

    /// <summary>
    /// Reopening a file-based app root must REPLACE its ad-hoc project, not add a second one
    /// beside it. A stale project keeps serving the text the file had at first open, so the
    /// editor answers every request about the file from a snapshot the user can no longer see.
    /// Proven by breaking the file on disk between the two opens: the error only surfaces if
    /// the reopen won. Implements [SCRIPT-FILEBASED].
    /// </summary>
    [Fact]
    public async Task Reopening_a_file_based_root_replaces_its_project_rather_than_duplicating_it()
    {
        var app = _fixture.Write("Reopened.cs", "Console.WriteLine(1);\n");
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);
        Assert.Empty(await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app));

        _ = _fixture.Write("Reopened.cs", "Console.WriteLine(NoSuchSymbol);\n");
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        var errors = await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app);
        Assert.Contains(
            errors,
            diagnostic => string.Equals(diagnostic.Code, "CS0103", StringComparison.Ordinal)
        );
    }

    /// <summary>
    /// Typing a <c>#:package</c> line into an already-open file-based app must re-resolve the
    /// closure's packages and hand the restored assemblies to the compilation. Asserting only
    /// that the update succeeded proves nothing — the update returns success even when the
    /// restore degrades. Binding <c>JsonConvert</c> is what proves a real assembly arrived.
    /// </summary>
    [Fact]
    public async Task Adding_a_package_directive_by_editing_binds_the_restored_package_api()
    {
        var app = _fixture.Write("Live.cs", "Console.WriteLine(1);\n");
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        const string withPackage = """
            #:package Newtonsoft.Json@13.0.3
            using Newtonsoft.Json;
            Console.WriteLine(JsonConvert.SerializeObject(new { Value = 1 }));

            """;
        var updated = await manager.UpdateDocumentTextAsync(app, withPackage);
        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));

        var diagnostics = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, app);
        // A degraded restore leaves the notice behind, so its absence is the precondition for
        // the binding assertion below meaning anything at all.
        Assert.DoesNotContain(
            diagnostics,
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );
        Assert.DoesNotContain(
            diagnostics,
            diagnostic =>
                string.Equals(diagnostic.Severity, "error", StringComparison.OrdinalIgnoreCase)
        );
        await AssertJsonConvertHoverAsync(manager, app);
    }

    /// <summary>
    /// A package id that cannot be restored must NOT fail the load. The app keeps its BCL
    /// references and the sidecar publishes one informational notice naming the reason, so the
    /// editor can say "degraded" instead of drowning the file in phantom errors.
    /// Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task An_unresolvable_package_degrades_to_bcl_references_with_one_notice()
    {
        var app = _fixture.Write(
            "Missing.cs",
            "#:package SharpLsp.No.Such.Package.Exists@9.9.9\nConsole.WriteLine(\"still binds\".Length);\n"
        );
        using var manager = new WorkspaceManager();

        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, app);

        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded);
        var diagnostics = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, app);
        var notice = Assert.Single(
            diagnostics,
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );
        Assert.Equal("Info", notice.Severity);
        Assert.Contains(
            "SharpLsp.No.Such.Package.Exists",
            notice.Message,
            StringComparison.Ordinal
        );
        // The BCL fallback is the whole point of degrading: `string.Length` must still bind.
        Assert.Empty(await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app));
    }

    /// <summary>
    /// The synthesized restore project lives in a temp directory, far outside the app's own
    /// MSBuild cone. It must nevertheless be evaluated under the app's <c>Directory.Build.targets</c>,
    /// or a repository whose cone pins feeds, versions or a central package management policy would
    /// restore against completely different rules than <c>dotnet run app.cs</c> does.
    ///
    /// Proven with a cone file that fails the restore with a unique marker: if the marker reaches
    /// the degradation notice, the app's cone was applied to the synthesized project.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
    /// </summary>
    [Fact]
    public async Task The_apps_msbuild_cone_is_applied_to_the_synthesized_restore_project()
    {
        // A dedicated subdirectory: a Directory.Build.targets at the fixture root would be
        // inherited by every other app in this class.
        _ = _fixture.Write(
            Path.Combine("cone", "Directory.Build.targets"),
            """
            <Project>
              <Target Name="SharpLspConeProbe" BeforeTargets="Restore">
                <Error Text="sharplsp-cone-probe-reached" />
              </Target>
            </Project>

            """
        );
        var app = _fixture.Write(
            Path.Combine("cone", "Coned.cs"),
            "#:package Newtonsoft.Json@13.0.3\nConsole.WriteLine(1);\n"
        );
        using var manager = new WorkspaceManager();

        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        var diagnostics = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, app);
        var notice = Assert.Single(
            diagnostics,
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );
        Assert.Contains("sharplsp-cone-probe-reached", notice.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Deleting the <c>#:package</c> line must clear the degraded status. A notice that outlives
    /// the directive that caused it tells the user their working file is still degraded when it
    /// is not — and it is published on every subsequent diagnostics pull.
    /// Implements [SCRIPT-DEGRADE].
    /// </summary>
    [Fact]
    public async Task Deleting_the_package_directive_clears_the_degradation_notice()
    {
        var app = _fixture.Write(
            "Cleared.cs",
            "#:package SharpLsp.No.Such.Package.Exists@9.9.9\nConsole.WriteLine(1);\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);
        Assert.Contains(
            await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, app),
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );

        var updated = await manager.UpdateDocumentTextAsync(app, "Console.WriteLine(1);\n");

        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));
        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, app),
            diagnostic =>
                string.Equals(
                    diagnostic.Code,
                    ProjectlessWorkspaceFixture.DegradationCode,
                    StringComparison.Ordinal
                )
        );
    }

    /// <summary>
    /// Typing a new <c>#:include</c> must pull the target into the live project. Until it does,
    /// the symbols it declares report CS0103 and the editor is lying about the user's own code.
    /// Implements [SCRIPT-CLOSURE].
    /// </summary>
    [Fact]
    public async Task Adding_an_include_directive_by_editing_pulls_the_target_into_the_closure()
    {
        var app = _fixture.Write("Grow.cs", "Console.WriteLine(1);\n");
        _ = _fixture.Write(
            "grown.cs",
            "internal static class Grown { public static int V() { return 7; } }\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);

        var updated = await manager.UpdateDocumentTextAsync(
            app,
            "#:include grown.cs\nConsole.WriteLine(Grown.V());\n"
        );

        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));
        Assert.Empty(await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app));
    }

    /// <summary>
    /// Deleting an <c>#:include</c> must drop the orphan from the project. A stale document left
    /// behind keeps compiling, so a type the root file now declares itself collides with the one
    /// still in the project and the user sees a CS0101 duplicate-definition error they cannot
    /// explain. Implements [SCRIPT-CLOSURE].
    /// </summary>
    [Fact]
    public async Task Deleting_an_include_directive_drops_the_orphaned_document()
    {
        var app = _fixture.Write(
            "Shrink.cs",
            "#:include shrunk.cs\nConsole.WriteLine(Shared.V());\n"
        );
        _ = _fixture.Write(
            "shrunk.cs",
            "internal static class Shared { public static int V() { return 1; } }\n"
        );
        using var manager = new WorkspaceManager();
        Assert.False((await ProjectlessWorkspaceFixture.OpenAsync(manager, app)).IsError);
        Assert.Empty(await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app));

        // The root file now declares `Shared` itself. If the orphan survived the edit both
        // declarations are in the compilation and CS0101 fires.
        var updated = await manager.UpdateDocumentTextAsync(
            app,
            "Console.WriteLine(Shared.V());\ninternal static class Shared { public static int V() { return 2; } }\n"
        );

        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));
        var errors = await ProjectlessWorkspaceFixture.ErrorsAsync(manager, app);
        Assert.DoesNotContain(
            errors,
            diagnostic => string.Equals(diagnostic.Code, "CS0101", StringComparison.Ordinal)
        );
        Assert.Empty(errors);
    }

    private static async Task AssertJsonConvertHoverAsync(WorkspaceManager manager, string app)
    {
        var result = await manager.GetHoverAsync(app, 2, 20).ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        var hover = +result;
        Assert.NotNull(hover);
        Assert.Contains("Newtonsoft.Json.JsonConvert", hover.Contents, StringComparison.Ordinal);
        Assert.Equal(2, hover.StartLine);
        Assert.Equal(18, hover.StartCharacter);
        Assert.Equal(2, hover.EndLine);
        Assert.Equal(29, hover.EndCharacter);
    }
}
