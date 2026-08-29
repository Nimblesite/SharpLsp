using System.Diagnostics;
using System.Xml;
using System.Xml.Linq;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xUnit requires the public partial test class.
// RS1035: these end-to-end helpers deliberately exercise real files and real MSBuild state.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed partial class FileBasedPackageSpecEndToEndTests
{
    private string WriteConcurrentApp()
    {
        WriteAppCone();
        return _fixture.Write(
            Path.Combine("cone", "Concurrent.cs"),
            "#:package Newtonsoft.Json\n#:property DefineConstants=FROM_DIRECTIVE;$(DefineConstants)\n#:property AssemblyTitle=Sharp & Precise\nusing Newtonsoft.Json;\nConsole.WriteLine(JsonConvert.SerializeObject(3));\n"
        );
    }

    private static async Task<ConcurrentObservation> OpenManagersAndObserveAsync(
        WorkspaceManager first,
        WorkspaceManager second,
        string app,
        string restoreRoot
    )
    {
        var firstOpening = ProjectlessWorkspaceFixture.OpenAsync(first, app);
        var secondOpening = ProjectlessWorkspaceFixture.OpenAsync(second, app);
        var project = await WaitForRestoreProjectAsync(restoreRoot).ConfigureAwait(false);
        var firstOpened = await firstOpening.ConfigureAwait(false);
        var secondOpened = await secondOpening.ConfigureAwait(false);
        return new(firstOpened, secondOpened, project);
    }

    private static void AssertConcurrentProjects(
        string app,
        string restoreRoot,
        ConcurrentObservation observed
    )
    {
        AssertDeterministicProjectPath(app, restoreRoot, observed.Project.ProjectPath);
        AssertSynthesizedProjectDom(observed.Project.Project);
    }

    private static async Task AssertConcurrentManagersLoadedAsync(
        WorkspaceManager first,
        WorkspaceManager second,
        string app
    )
    {
        await AwaitStatusAsync(first, "loaded").ConfigureAwait(false);
        await AwaitStatusAsync(second, "loaded").ConfigureAwait(false);
        Assert.True(first.IsLoaded);
        Assert.True(second.IsLoaded);
        await AssertConcurrentDiagnosticsAsync(first, second, app).ConfigureAwait(false);
        await AssertConcurrentHoversAsync(first, second, app).ConfigureAwait(false);
    }

    private static async Task AssertConcurrentDiagnosticsAsync(
        WorkspaceManager first,
        WorkspaceManager second,
        string app
    )
    {
        var firstDiagnostics = await DiagnosticsAsync(first, app).ConfigureAwait(false);
        var secondDiagnostics = await DiagnosticsAsync(second, app).ConfigureAwait(false);
        Assert.Empty(Errors(firstDiagnostics));
        Assert.Empty(Errors(secondDiagnostics));
        Assert.DoesNotContain(firstDiagnostics, item => item.Code == DegradationCode);
        Assert.DoesNotContain(secondDiagnostics, item => item.Code == DegradationCode);
    }

    private static async Task AssertConcurrentHoversAsync(
        WorkspaceManager first,
        WorkspaceManager second,
        string app
    )
    {
        var probe = new HoverProbe(app, 4, 20, "Newtonsoft.Json.JsonConvert");
        var firstHover = await WaitHoverAsync(first, probe).ConfigureAwait(false);
        var secondHover = await WaitHoverAsync(second, probe).ConfigureAwait(false);
        AssertHoverRange(firstHover, 4, 18, 29);
        AssertHoverRange(secondHover, 4, 18, 29);
    }

    private static async Task<ProjectSnapshot> WaitForRestoreProjectAsync(string restoreRoot)
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < ResolutionTimeout)
        {
            var snapshot = TryReadRestoreProject(restoreRoot);
            if (snapshot is not null)
            {
                return snapshot;
            }
            await Task.Delay(10).ConfigureAwait(false);
        }
        return ReadRestoreProject(restoreRoot);
    }

    private static ProjectSnapshot? TryReadRestoreProject(string restoreRoot)
    {
        try
        {
            return TryReadExistingProject(restoreRoot);
        }
        catch (Exception exception) when (exception is IOException or XmlException)
        {
            return null;
        }
    }

    private static ProjectSnapshot? TryReadExistingProject(string restoreRoot)
    {
        var projects = RestoreProjects(restoreRoot);
        return projects.Length == 1 ? ReadProject(projects[0]) : null;
    }

    private static ProjectSnapshot ReadRestoreProject(string restoreRoot)
    {
        var projects = RestoreProjects(restoreRoot);
        return ReadProject(Assert.Single(projects));
    }

    private static string[] RestoreProjects(string restoreRoot)
    {
        var generations = Path.Combine(restoreRoot, "generations");
        return !Directory.Exists(generations)
            ? []
            : Directory.GetFiles(generations, "restore.csproj", SearchOption.AllDirectories);
    }

    private static ProjectSnapshot ReadProject(string projectPath)
    {
        using var stream = File.Open(
            projectPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete
        );
        var project = XDocument.Load(stream, LoadOptions.PreserveWhitespace);
        return new ProjectSnapshot(projectPath, project);
    }

    private sealed record ConcurrentObservation(
        Outcome.Result<Outcome.Unit, string> FirstOpened,
        Outcome.Result<Outcome.Unit, string> SecondOpened,
        ProjectSnapshot Project
    );
}
