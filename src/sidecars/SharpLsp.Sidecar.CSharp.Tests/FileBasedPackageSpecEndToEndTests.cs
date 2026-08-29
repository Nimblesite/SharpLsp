using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xUnit requires public test classes.
// RS1035: these end-to-end tests deliberately exercise real files and real MSBuild state.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Assertion-heavy specification coverage for file-based package resolution through the real
/// <see cref="WorkspaceManager"/>. No resolver is mocked: every case writes an actual app and
/// drives the same tier-2-to-tier-1 transition used by the sidecar.
///
/// Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD],
/// [SCRIPT-FILEBASED-REFERENCES-FALLBACK], [SCRIPT-FILEBASED-DIRECTIVES],
/// [SCRIPT-RELOAD], [SCRIPT-MULTIROOT], and [SCRIPT-DEGRADE].
/// </summary>
public sealed partial class FileBasedPackageSpecEndToEndTests : IDisposable
{
    private const string DegradationCode = "SLSPC0001";
    private const string ClearPackageText = "Console.WriteLine(\"clear\".Length);\n";
    private static readonly TimeSpan ResolutionTimeout = TimeSpan.FromSeconds(45);
    private readonly ProjectlessWorkspaceFixture _fixture = new("pkg-spec");
    private readonly HashSet<string> _restoreDirectories = new(StringComparer.OrdinalIgnoreCase);

    public void Dispose()
    {
        _fixture.Dispose();
        foreach (var directory in _restoreDirectories.Where(Directory.Exists))
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// The virtual project must be stable, well-formed MSBuild XML and must evaluate in the app's
    /// configuration cone. A bare package proves CPM was imported; the two conditional symbols
    /// prove both Directory.Build.props and #:property reached Roslyn's real parse options.
    /// </summary>
    [Fact]
    public async Task Bare_cpm_package_uses_deterministic_dom_project_and_app_cone_options()
    {
        var app = WriteCpmApp();
        var restoreRoot = PrepareRestoreRoot(app);
        using var manager = new WorkspaceManager();
        var observed = await OpenAndObserveProjectAsync(manager, app, restoreRoot);
        var projectPath = observed.ProjectPath;
        AssertSucceeded(observed.Opened);
        Assert.True(manager.IsLoaded, "tier 2 must exist while the real restore is pending");
        Assert.NotEmpty(observed.Project.Descendants());
        AssertDeterministicProjectPath(app, restoreRoot, projectPath);
        AssertSynthesizedProjectDom(observed.Project);
        await AwaitStatusAsync(manager, "loaded");
        AssertGenerationCleaned(projectPath);
        await AssertCpmResultAsync(manager, app);
    }

    /// <summary>
    /// A terminal restore failure remains a visible informational diagnostic with an exact range,
    /// while the fallback compilation continues to provide real BCL semantics.
    /// </summary>
    [Fact]
    public async Task Restore_failure_reports_exact_tier2_notice_while_bcl_symbols_bind()
    {
        const string package = "SharpLsp.Spec.Package.Does.Not.Exist@9.9.9";
        var app = WriteFallbackApp(package);
        using var manager = new WorkspaceManager();
        AssertSucceeded(await ProjectlessWorkspaceFixture.OpenAsync(manager, app));
        var diagnostics = await WaitNoticeAsync(manager, new(app, package));
        AssertFallbackContract(manager, app, package, diagnostics);
        await AssertLengthHoverAsync(manager, app);
    }

    /// <summary>
    /// An older restore completion must never overwrite the latest directive generation. The
    /// second package identity must own the failure, and removing it must permanently clear the
    /// degraded state even while earlier real restore processes are winding down.
    /// </summary>
    [Fact]
    public async Task Rapid_package_swaps_publish_only_the_current_generation()
    {
        const string oldPackage = "SharpLsp.Stale.Package.Does.Not.Exist@1.0.0";
        const string currentPackage = "SharpLsp.Current.Package.Does.Not.Exist@2.0.0";
        var app = WriteGenerationApp(oldPackage);
        using var manager = new WorkspaceManager();
        AssertSucceeded(await ProjectlessWorkspaceFixture.OpenAsync(manager, app));
        AssertSucceeded(await SwapPackageAsync(manager, app, currentPackage));
        var current = await WaitNoticeAsync(manager, new(app, currentPackage));
        AssertCurrentGeneration(current, oldPackage, currentPackage);
        AssertSucceeded(await manager.UpdateDocumentTextAsync(app, ClearPackageText));
        await AwaitStatusAsync(manager, "loaded");
        await AssertStableFullLoadAsync(manager, app);
    }

    /// <summary>
    /// Two roots in one project-less directory are separate projects and separate package graphs.
    /// A package restored for the first root must bind there, must not leak into the second root,
    /// and the two top-level programs must never acquire a duplicate-entry-point diagnostic.
    /// </summary>
    [Fact]
    public async Task Package_references_and_entry_points_are_isolated_per_root()
    {
        var (packageRoot, bareRoot) = WriteIndependentRoots();
        using var manager = new WorkspaceManager();
        AssertSucceeded(await ProjectlessWorkspaceFixture.OpenAsync(manager, _fixture.Root));
        Assert.False(manager.IsLoaded, "a project-less directory defers until a document opens");
        AssertSucceeded(await OpenRootAsync(manager, packageRoot));
        AssertSucceeded(await OpenRootAsync(manager, bareRoot));
        Assert.True(manager.IsLoaded);
        _ = await WaitHoverAsync(manager, new(packageRoot, 2, 20, "Newtonsoft.Json.JsonConvert"));
        await AwaitStatusAsync(manager, "loaded");
        await AssertRootIsolationAsync(manager, packageRoot, bareRoot);
    }

    /// <summary>
    /// Dispose is repeat-safe even when it cancels an active real restore generation.
    /// Implements [SCRIPT-LIFECYCLE].
    /// </summary>
    [Fact]
    public async Task Dispose_is_idempotent_during_an_active_package_restore()
    {
        var app = _fixture.Write(
            "Dispose.cs",
            "#:package SharpLsp.Dispose.Package.Does.Not.Exist@9.9.9\nConsole.WriteLine(1);\n"
        );
        _ = PrepareRestoreRoot(app);
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, app);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded);
        Assert.Equal("filebased-degraded", manager.Status);

        var firstDispose = Record.Exception(manager.Dispose);
        var secondDispose = Record.Exception(manager.Dispose);

        Assert.Null(firstDispose);
        Assert.Null(secondDispose);
    }

    /// <summary>
    /// Two real managers restoring the same app must serialize use of the same deterministic
    /// generation path. Both managers must bind, and the shared build state must be cleaned.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-MSBUILD] and [SCRIPT-LIFECYCLE].
    /// </summary>
    [Fact]
    public async Task Concurrent_managers_serialize_and_clean_same_app_generation()
    {
        var app = WriteConcurrentApp();
        var restoreRoot = PrepareRestoreRoot(app);
        using var first = new WorkspaceManager();
        using var second = new WorkspaceManager();
        var observed = await OpenManagersAndObserveAsync(first, second, app, restoreRoot);
        AssertSucceeded(observed.FirstOpened);
        AssertSucceeded(observed.SecondOpened);
        AssertConcurrentProjects(app, restoreRoot, observed);
        await AssertConcurrentManagersLoadedAsync(first, second, app);
        AssertGenerationCleaned(observed.Project.ProjectPath);
    }

    /// <summary>
    /// The editor pushes didChange for every file it holds open, and that includes an
    /// <c>#:include</c>d member of a file-based closure. A closure is owned by its ROOT, so a
    /// refresh driven from a member must re-expand from the root: expanding from the member
    /// instead yields a closure that does not contain the root, and the reconciliation then
    /// prunes the root out of its own project, leaving the document the user is editing
    /// completely unserved. Implements [SCRIPT-CLOSURE], [SCRIPT-FILEBASED-DIRECTIVES] and
    /// [SCRIPT-RELOAD].
    /// </summary>
    [Fact]
    public async Task Edit_of_an_included_member_keeps_the_root_served_and_bound()
    {
        var closure = WriteIncludedPackageClosure();
        _ = PrepareRestoreRoot(closure.Root);
        using var manager = new WorkspaceManager();
        AssertSucceeded(await ProjectlessWorkspaceFixture.OpenAsync(manager, closure.Root));
        _ = await WaitHoverAsync(manager, new(closure.Root, 1, 20, "PackageFactory"));
        await AwaitStatusAsync(manager, "loaded");

        AssertSucceeded(await manager.UpdateDocumentTextAsync(closure.Member, closure.MemberText));

        await AssertClosureSurvivedMemberEditAsync(manager, closure);
    }

    private string PrepareRestoreRoot(string app)
    {
        var fullPath = Path.GetFullPath(app);
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes(fullPath));
        var hash = Convert.ToHexString(digest)[..16];
        var directory = Path.Combine(
            Path.GetTempPath(),
            "dotnet",
            "runfile",
            $"{Path.GetFileNameWithoutExtension(fullPath)}-{hash}"
        );
        if (Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
        _ = _restoreDirectories.Add(directory);
        return directory;
    }

    private static void AssertGenerationDirectory(string restoreRoot, string projectPath)
    {
        var generationRoot = Assert.IsType<string>(Path.GetDirectoryName(projectPath));
        var directoryName = Path.GetFileName(generationRoot);
        Assert.Equal($"{Environment.ProcessId}-1", directoryName);
        Assert.Equal(
            Path.Combine(restoreRoot, "generations"),
            Path.GetDirectoryName(generationRoot)
        );
    }

    private sealed record ClosureProbe(string Root, string Member, string MemberText);

    private sealed record HoverProbe(string App, int Line, int Character, string Expected);

    private sealed record NoticeProbe(string App, string Package);

    private sealed record OpenObservation(
        Outcome.Result<Outcome.Unit, string> Opened,
        string ProjectPath,
        XDocument Project
    );

    private sealed record ProjectSnapshot(string ProjectPath, XDocument Project);
}
