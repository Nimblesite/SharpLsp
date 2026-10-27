using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Per-document pull diagnostics must carry project analyzer diagnostics —
/// SDK/NuGet <c>DiagnosticAnalyzer</c> instances and the IDE style analyzers —
/// beside the compiler diagnostics, exactly once, honoring NoWarn, .editorconfig
/// severities and suppressions ([DIAG-CATEGORIES-ANALYZER], [DIAG-CONFIG]).
/// Proven on a real project whose .editorconfig promotes CA1822 to an error:
/// it appears, clears after the fix, and reappears on regression.
/// </summary>
public sealed class AnalyzerDocumentDiagnosticsTests : IDisposable
{
    private const string InstanceMemberSource = """
        namespace Sample;

        public class Greeter
        {
            public int Compute() => 41;
        }
        """;

    private const string StaticMemberSource = """
        namespace Sample;

        public class Greeter
        {
            public static int Compute() => 41;
        }
        """;

    private const string CompilerErrorSuffix =
        "\n\npublic class Broken { public int Fall() => missing; }\n";

    private const string EditorConfigError = """
        root = true

        [*.cs]
        dotnet_diagnostic.CA1822.severity = error
        """;

    private const string EditorConfigNone = """
        root = true

        [*.cs]
        dotnet_diagnostic.CA1822.severity = none
        """;

    private const string DefaultCsproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
            <EnableNETAnalyzers>true</EnableNETAnalyzers>
          </PropertyGroup>
        </Project>
        """;

    private const string NoWarnCsproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
            <EnableNETAnalyzers>true</EnableNETAnalyzers>
            <NoWarn>$(NoWarn);CA1822</NoWarn>
          </PropertyGroup>
        </Project>
        """;

    private const string SuppressedSource =
        "namespace Sample;\n\npublic class Greeter\n{\n#pragma warning disable CA1822\n    public int Compute() => 41;\n#pragma warning restore CA1822\n}\n";

    private const string MainProjectDirectory = "Main";
    private const string SourceName = "Greeter.cs";

    private readonly ProjectlessWorkspaceFixture _files = new("ca1822");

    private readonly string _sourceRelative;
    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public AnalyzerDocumentDiagnosticsTests()
    {
        _sourceRelative = NativePaths.Join(MainProjectDirectory, SourceName);
        _csprojPath = WriteProject(
            MainProjectDirectory,
            "Main.csproj",
            DefaultCsproj,
            EditorConfigError
        );
        _sourcePath = NativePaths.Join(NativePaths.DirectoryOf(_csprojPath), SourceName);
    }

    public void Dispose()
    {
        _files.Dispose();
    }

    private string WriteProject(
        string projectDirectory,
        string projectName,
        string csproj,
        string editorConfig,
        bool withCompilerError = false
    )
    {
        var projectPath = _files.Write(NativePaths.Join(projectDirectory, projectName), csproj);
        _ = _files.Write(NativePaths.Join(projectDirectory, ".editorconfig"), editorConfig);
        _ = _files.Write(
            NativePaths.Join(projectDirectory, SourceName),
            withCompilerError ? InstanceMemberSource + CompilerErrorSuffix : InstanceMemberSource
        );
        return projectPath;
    }

    [Fact]
    public async Task A_configured_CA1822_error_is_reported_by_default()
    {
        using var manager = await OpenAsync(_csprojPath);

        Assert.Contains(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task The_analyzer_error_clears_after_the_member_becomes_static()
    {
        using var manager = await OpenAsync(_csprojPath);
        Assert.Contains(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath),
            IsCa1822Error
        );

        _ = _files.Write(_sourceRelative, StaticMemberSource);
        var updated = await manager.UpdateDocumentTextAsync(_sourcePath, StaticMemberSource);
        Assert.False(updated.IsError, updated.Match(_ => "ok", error => error));

        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task The_analyzer_error_reappears_on_regression()
    {
        using var manager = await OpenAsync(_csprojPath);
        _ = _files.Write(_sourceRelative, StaticMemberSource);
        _ = await manager.UpdateDocumentTextAsync(_sourcePath, StaticMemberSource);
        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath),
            IsCa1822Error
        );

        _ = _files.Write(_sourceRelative, InstanceMemberSource);
        _ = await manager.UpdateDocumentTextAsync(_sourcePath, InstanceMemberSource);

        Assert.Contains(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task Analyzer_diagnostics_are_reported_once()
    {
        using var manager = await OpenAsync(_csprojPath);

        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath);
        var ca1822 = diagnostics.Where(IsCa1822Error).ToList();

        _ = Assert.Single(ca1822);
    }

    [Fact]
    public async Task Compiler_diagnostics_are_reported_beside_the_analyzer()
    {
        var projectPath = WriteProject(
            "WithCompilerError",
            "WithCompilerError.csproj",
            DefaultCsproj,
            EditorConfigError,
            withCompilerError: true
        );
        using var manager = await OpenAsync(projectPath);

        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(
            manager,
            NativePaths.Join(NativePaths.DirectoryOf(projectPath), SourceName)
        );

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Code.StartsWith("CS", StringComparison.Ordinal)
        );
        Assert.Contains(diagnostics, IsCa1822Error);
    }

    [Fact]
    public async Task NoWarn_silences_the_analyzer_rule()
    {
        var projectPath = WriteProject("NoWarn", "NoWarn.csproj", NoWarnCsproj, EditorConfigError);
        using var manager = await OpenAsync(projectPath);

        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(
                manager,
                NativePaths.Join(NativePaths.DirectoryOf(projectPath), SourceName)
            ),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task An_editorconfig_severity_of_none_silences_the_analyzer_rule()
    {
        var projectPath = WriteProject("None", "None.csproj", DefaultCsproj, EditorConfigNone);
        using var manager = await OpenAsync(projectPath);

        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(
                manager,
                NativePaths.Join(NativePaths.DirectoryOf(projectPath), SourceName)
            ),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task A_pragma_suppression_silences_the_analyzer_rule()
    {
        var projectPath = WriteProject(
            "Suppressed",
            "Suppressed.csproj",
            DefaultCsproj,
            EditorConfigError
        );
        _ = _files.Write(NativePaths.Join("Suppressed", SourceName), SuppressedSource);
        using var manager = await OpenAsync(projectPath);

        Assert.DoesNotContain(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(
                manager,
                NativePaths.Join(NativePaths.DirectoryOf(projectPath), SourceName)
            ),
            IsCa1822Error
        );
    }

    [Fact]
    public async Task Opting_out_of_analyzers_keeps_compiler_diagnostics()
    {
        var projectPath = WriteProject(
            "OptOut",
            "OptOut.csproj",
            DefaultCsproj,
            EditorConfigError,
            withCompilerError: true
        );
        var sourcePath = NativePaths.Join(NativePaths.DirectoryOf(projectPath), SourceName);
        using var manager = await OpenAsync(projectPath);
        manager.ConfigureDiagnostics(analyzersEnabled: false);

        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, sourcePath);

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Code.StartsWith("CS", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(diagnostics, IsCa1822Error);
    }

    private static bool IsCa1822Error(DiagnosticResult diagnostic)
    {
        return diagnostic.Code == "CA1822" && diagnostic.Severity == "Error";
    }

    private static async Task<WorkspaceManager> OpenAsync(string projectPath)
    {
        var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture
            .OpenAsync(manager, projectPath)
            .ConfigureAwait(false);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded, "workspace must be loaded for diagnostics");
        return manager;
    }
}
