using System.Diagnostics;
using System.Xml.Linq;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xUnit requires the public partial test class.
// RS1035: these end-to-end helpers deliberately exercise real files and real MSBuild state.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed partial class FileBasedPackageSpecEndToEndTests
{
    private string WriteCpmApp()
    {
        WriteAppCone();
        const string source = """
            #:package Newtonsoft.Json
            #:property DefineConstants=FROM_DIRECTIVE;$(DefineConstants)
            #:property AssemblyTitle=Sharp & Precise
            using Newtonsoft.Json;
            #if FROM_CONE && FROM_DIRECTIVE
            Console.WriteLine(JsonConvert.SerializeObject(new { Value = 7 }));
            #else
            #error app-cone-or-directive-property-was-not-applied
            #endif

            """;
        return _fixture.Write(Path.Combine("cone", "CpmApp.cs"), source);
    }

    private string WriteFallbackApp(string package)
    {
        var app = _fixture.Write(
            "Fallback.cs",
            $"#:package {package}\nvar length = \"bound\".Length;\nConsole.WriteLine(length);\n"
        );
        _ = PrepareRestoreRoot(app);
        return app;
    }

    private string WriteGenerationApp(string package)
    {
        var app = _fixture.Write(
            "Generation.cs",
            $"#:package {package}\nConsole.WriteLine(\"old\".Length);\n"
        );
        _ = PrepareRestoreRoot(app);
        return app;
    }

    private (string PackageRoot, string BareRoot) WriteIndependentRoots()
    {
        var packageRoot = _fixture.Write(
            "WithPackage.cs",
            "#:package Newtonsoft.Json@13.0.3\nusing Newtonsoft.Json;\nConsole.WriteLine(JsonConvert.SerializeObject(1));\n"
        );
        var bareRoot = _fixture.Write(
            "WithoutPackage.cs",
            "using Newtonsoft.Json;\nConsole.WriteLine(JsonConvert.SerializeObject(2));\n"
        );
        _ = PrepareRestoreRoot(packageRoot);
        _ = PrepareRestoreRoot(bareRoot);
        return (packageRoot, bareRoot);
    }

    private static async Task AssertCpmResultAsync(WorkspaceManager manager, string app)
    {
        var diagnostics = await DiagnosticsAsync(manager, app).ConfigureAwait(false);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == DegradationCode);
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS1029");
        Assert.Empty(Errors(diagnostics));
        var hover = await WaitHoverAsync(manager, new(app, 5, 20, "Newtonsoft.Json.JsonConvert"))
            .ConfigureAwait(false);
        AssertHoverRange(hover, 5, 18, 29);
    }

    private static void AssertFallbackContract(
        WorkspaceManager manager,
        string app,
        string package,
        List<DiagnosticResult> diagnostics
    )
    {
        Assert.True(manager.IsLoaded, "tier-2 fallback must remain queryable");
        Assert.Equal("filebased-degraded", manager.Status);
        var notice = Assert.Single(diagnostics, diagnostic => diagnostic.Code == DegradationCode);
        AssertNoticeLocation(notice, app);
        AssertNoticeMessage(notice, package);
        Assert.Empty(Errors(diagnostics));
    }

    private static void AssertNoticeLocation(DiagnosticResult notice, string app)
    {
        Assert.Equal(app, notice.FilePath);
        Assert.Equal("Info", notice.Severity);
        Assert.Equal(0, notice.StartLine);
        Assert.Equal(0, notice.StartCharacter);
        Assert.Equal(0, notice.EndLine);
        Assert.Equal(1, notice.EndCharacter);
    }

    private static void AssertNoticeMessage(DiagnosticResult notice, string package)
    {
        Assert.StartsWith(
            "File-based package restore degraded to BCL-only references: Restore failed for",
            notice.Message,
            StringComparison.Ordinal
        );
        Assert.Contains(package, notice.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("pending", notice.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task AssertLengthHoverAsync(WorkspaceManager manager, string app)
    {
        var hover = await WaitHoverAsync(manager, new(app, 1, 23, "string.Length"))
            .ConfigureAwait(false);
        AssertHoverRange(hover, 1, 21, 27);
    }

    private static void AssertHoverRange(HoverResult hover, int line, int start, int end)
    {
        Assert.Equal(line, hover.StartLine);
        Assert.Equal(start, hover.StartCharacter);
        Assert.Equal(line, hover.EndLine);
        Assert.Equal(end, hover.EndCharacter);
    }

    private static async Task<Outcome.Result<Outcome.Unit, string>> SwapPackageAsync(
        WorkspaceManager manager,
        string app,
        string package
    )
    {
        var source = $"#:package {package}\nConsole.WriteLine(\"current\".Length);\n";
        return await manager.UpdateDocumentTextAsync(app, source).ConfigureAwait(false);
    }

    private static void AssertCurrentGeneration(
        List<DiagnosticResult> diagnostics,
        string oldPackage,
        string currentPackage
    )
    {
        var notice = Assert.Single(diagnostics, diagnostic => diagnostic.Code == DegradationCode);
        Assert.Contains(currentPackage, notice.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(oldPackage, notice.Message, StringComparison.Ordinal);
        Assert.Empty(Errors(diagnostics));
    }

    private static async Task<Outcome.Result<Outcome.Unit, string>> OpenRootAsync(
        WorkspaceManager manager,
        string root
    )
    {
        var text = await File.ReadAllTextAsync(root).ConfigureAwait(false);
        return await manager.UpdateDocumentTextAsync(root, text).ConfigureAwait(false);
    }

    private static async Task AssertRootIsolationAsync(
        WorkspaceManager manager,
        string packageRoot,
        string bareRoot
    )
    {
        var packageDiagnostics = await DiagnosticsAsync(manager, packageRoot).ConfigureAwait(false);
        var bareDiagnostics = await DiagnosticsAsync(manager, bareRoot).ConfigureAwait(false);
        AssertPackageRootDiagnostics(packageDiagnostics);
        AssertBareRootDiagnostics(bareDiagnostics);
        await AssertRootHoverIsolationAsync(manager, packageRoot, bareRoot).ConfigureAwait(false);
    }

    private static async Task AssertRootHoverIsolationAsync(
        WorkspaceManager manager,
        string packageRoot,
        string bareRoot
    )
    {
        var hover = await WaitHoverAsync(
                manager,
                new(packageRoot, 2, 20, "Newtonsoft.Json.JsonConvert")
            )
            .ConfigureAwait(false);
        AssertHoverRange(hover, 2, 18, 29);
        Assert.Null(AssertOk(await manager.GetHoverAsync(bareRoot, 1, 20).ConfigureAwait(false)));
    }

    private static void AssertPackageRootDiagnostics(List<DiagnosticResult> diagnostics)
    {
        Assert.Empty(Errors(diagnostics));
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS8802");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS0017");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == DegradationCode);
    }

    private static void AssertBareRootDiagnostics(List<DiagnosticResult> diagnostics)
    {
        Assert.Contains(Errors(diagnostics), diagnostic => diagnostic.Code == "CS0246");
        Assert.Contains(Errors(diagnostics), diagnostic => diagnostic.Code == "CS0103");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS8802");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "CS0017");
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == DegradationCode);
    }

    private void WriteAppCone()
    {
        _ = _fixture.Write(
            Path.Combine("cone", "Directory.Build.props"),
            "<Project><PropertyGroup><DefineConstants>FROM_CONE;$(DefineConstants)</DefineConstants></PropertyGroup></Project>\n"
        );
        _ = _fixture.Write(
            Path.Combine("cone", "Directory.Packages.props"),
            "<Project><PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup><ItemGroup><PackageVersion Include=\"Newtonsoft.Json\" Version=\"13.0.3\" /></ItemGroup></Project>\n"
        );
    }

    private static async Task<OpenObservation> OpenAndObserveProjectAsync(
        WorkspaceManager manager,
        string app,
        string restoreRoot
    )
    {
        var opening = ProjectlessWorkspaceFixture.OpenAsync(manager, app);
        var snapshot = await WaitForRestoreProjectAsync(restoreRoot).ConfigureAwait(false);
        var opened = await opening.ConfigureAwait(false);
        return new OpenObservation(opened, snapshot.ProjectPath, snapshot.Project);
    }

    private static void AssertDeterministicProjectPath(
        string app,
        string restoreRoot,
        string projectPath
    )
    {
        Assert.Equal(Path.GetFullPath(projectPath), projectPath);
        Assert.Equal("restore.csproj", Path.GetFileName(projectPath));
        AssertGenerationDirectory(restoreRoot, projectPath);
        Assert.StartsWith(
            $"{Path.GetFileNameWithoutExtension(app)}-",
            Path.GetFileName(restoreRoot),
            StringComparison.Ordinal
        );
    }

    private static void AssertGenerationCleaned(string projectPath)
    {
        Assert.False(File.Exists(projectPath));
        var generationRoot = Assert.IsType<string>(Path.GetDirectoryName(projectPath));
        Assert.False(Directory.Exists(generationRoot));
    }

    private static void AssertSynthesizedProjectDom(XDocument document)
    {
        var root = Assert.IsType<XElement>(document.Root);
        Assert.Equal("Project", root.Name.LocalName);
        Assert.Equal("Microsoft.NET.Sdk", root.Attribute("Sdk")?.Value);
        AssertDefaultProperties(document);
        AssertDirectiveProperties(document);
        AssertBarePackage(document);
    }

    private static void AssertDefaultProperties(XDocument document)
    {
        Assert.Equal(
            $"net{Environment.Version.Major}.0",
            Element(document, "TargetFramework").Value
        );
        Assert.Equal("enable", Element(document, "ImplicitUsings").Value);
        Assert.Equal("enable", Element(document, "Nullable").Value);
        Assert.Equal("Exe", Element(document, "OutputType").Value);
        Assert.Equal("true", Element(document, "PublishAot").Value);
        Assert.Equal("true", Element(document, "PackAsTool").Value);
    }

    private static void AssertDirectiveProperties(XDocument document)
    {
        Assert.Equal(
            "FROM_DIRECTIVE;$(DefineConstants)",
            Element(document, "DefineConstants").Value
        );
        Assert.Equal("Sharp & Precise", Element(document, "AssemblyTitle").Value);
    }

    private static void AssertBarePackage(XDocument document)
    {
        var package = Element(document, "PackageReference");
        Assert.Equal("Newtonsoft.Json", package.Attribute("Include")?.Value);
        Assert.Null(package.Attribute("Version"));
        Assert.DoesNotContain(package.Elements(), element => element.Name.LocalName == "Version");
    }

    private static XElement Element(XDocument document, string localName)
    {
        return Assert.Single(document.Descendants(), node => node.Name.LocalName == localName);
    }

    private static async Task AwaitStatusAsync(WorkspaceManager manager, string expected)
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < ResolutionTimeout && manager.Status != expected)
        {
            await Task.Delay(100).ConfigureAwait(false);
        }
        Assert.Equal(expected, manager.Status);
    }

    private static async Task<List<DiagnosticResult>> WaitNoticeAsync(
        WorkspaceManager manager,
        NoticeProbe probe
    )
    {
        var elapsed = Stopwatch.StartNew();
        List<DiagnosticResult> diagnostics = [];
        while (elapsed.Elapsed < ResolutionTimeout)
        {
            diagnostics = await DiagnosticsAsync(manager, probe.App).ConfigureAwait(false);
            if (diagnostics.Any(item => IsFinalNotice(item, probe.Package)))
            {
                return diagnostics;
            }
            await Task.Delay(100).ConfigureAwait(false);
        }
        return AssertFinalDegradation(diagnostics, probe.Package);
    }

    private static async Task<HoverResult> WaitHoverAsync(
        WorkspaceManager manager,
        HoverProbe probe
    )
    {
        var elapsed = Stopwatch.StartNew();
        HoverResult? hover = null;
        while (elapsed.Elapsed < ResolutionTimeout)
        {
            hover = await QueryHoverAsync(manager, probe).ConfigureAwait(false);
            if (hover?.Contents.Contains(probe.Expected, StringComparison.Ordinal) == true)
            {
                return hover;
            }
            await Task.Delay(100).ConfigureAwait(false);
        }
        return AssertExpectedHover(hover, probe.Expected);
    }

    private static async Task<HoverResult?> QueryHoverAsync(
        WorkspaceManager manager,
        HoverProbe probe
    )
    {
        return AssertOk(
            await manager
                .GetHoverAsync(probe.App, probe.Line, probe.Character)
                .ConfigureAwait(false)
        );
    }

    private static HoverResult AssertExpectedHover(HoverResult? hover, string expected)
    {
        Assert.NotNull(hover);
        Assert.Contains(expected, hover.Contents, StringComparison.Ordinal);
        return hover;
    }

    private static List<DiagnosticResult> AssertFinalDegradation(
        List<DiagnosticResult> diagnostics,
        string package
    )
    {
        Assert.Contains(diagnostics, item => IsFinalNotice(item, package));
        return diagnostics;
    }

    private static bool IsFinalNotice(DiagnosticResult diagnostic, string package)
    {
        return diagnostic.Code == DegradationCode
            && diagnostic.Message.Contains("Restore failed", StringComparison.Ordinal)
            && diagnostic.Message.Contains(package, StringComparison.Ordinal)
            && !diagnostic.Message.Contains("pending", StringComparison.OrdinalIgnoreCase);
    }

    private static async Task AssertStableFullLoadAsync(WorkspaceManager manager, string app)
    {
        for (var sample = 0; sample < 5; sample++)
        {
            await Task.Delay(200).ConfigureAwait(false);
            var diagnostics = await DiagnosticsAsync(manager, app).ConfigureAwait(false);
            Assert.Equal("loaded", manager.Status);
            Assert.DoesNotContain(diagnostics, item => item.Code == DegradationCode);
            Assert.Empty(Errors(diagnostics));
        }
    }

    private static async Task<List<DiagnosticResult>> DiagnosticsAsync(
        WorkspaceManager manager,
        string app
    )
    {
        return AssertOk(await manager.GetDiagnosticsAsync(app).ConfigureAwait(false));
    }

    private static List<DiagnosticResult> Errors(IEnumerable<DiagnosticResult> diagnostics)
    {
        return
        [
            .. diagnostics.Where(item =>
                string.Equals(item.Severity, "error", StringComparison.OrdinalIgnoreCase)
            ),
        ];
    }

    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    private static void AssertSucceeded(Outcome.Result<Outcome.Unit, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
    }
}
