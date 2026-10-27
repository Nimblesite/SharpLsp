using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: real filesystem and real
// dotnet restore are intentional — the repo mandates real files, not mocks.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// An analyzer reference the sidecar cannot load must never disappear silently
/// ([DIAG-CATEGORIES-ANALYZER]): Roslyn returns no analyzers from an assembly it
/// refuses to load, so without a report the project's diagnostics look clean while
/// <c>dotnet build</c> warns CS8032/CS9057. Proven on a real project whose
/// <c>Analyzer</c> item points at a file that is not a managed assembly: the
/// failure surfaces as a project-level CS8032 warning naming the assembly, beside
/// the project's real compiler diagnostics, and never as a clean empty result.
/// </summary>
public sealed class AnalyzerLoadFailureDiagnosticsTests : IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
          </PropertyGroup>
          <ItemGroup>
            <Analyzer Include="Bogus.dll" />
          </ItemGroup>
        </Project>
        """;

    private const string Source = """
        namespace Sample;

        public class Greeter
        {
            public int Compute() => 41;
        }
        """;

    private readonly ProjectlessWorkspaceFixture _files = new("analyzer-load");
    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public AnalyzerLoadFailureDiagnosticsTests()
    {
        _csprojPath = _files.Write("LoadFailure.csproj", Csproj);
        _sourcePath = _files.Write("Greeter.cs", Source);
        // A text file renamed to .dll: MSBuild accepts it as an Analyzer item, but
        // Roslyn refuses to load it as an assembly — exactly the SDK's CS8032 case.
        _ = _files.Write("Bogus.dll", "this is not a managed assembly");
        var (exitCode, output) = DotnetBuild.Restore(_csprojPath);
        Assert.True(exitCode == 0, $"dotnet restore must succeed: {output}");
    }

    public void Dispose()
    {
        _files.Dispose();
    }

    [Fact]
    public async Task An_unloadable_analyzer_reference_reports_CS8032_at_the_project()
    {
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, _csprojPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        var diagnostics = await ProjectDiagnosticsAsync(manager, _csprojPath);

        // The load failure is never dropped: the project reports the SDK build's
        // own code, at the project URI, zero-length range at line zero.
        var failure = Assert.Single(diagnostics, diagnostic => diagnostic.Code == "CS8032");
        Assert.Equal("Warning", failure.Severity);
        Assert.True(
            NativePaths.AreEqual(_csprojPath, failure.FilePath),
            $"the failure is reported at the project: {failure.FilePath}"
        );
        Assert.Equal(0, failure.StartLine);
        Assert.Equal(0, failure.StartCharacter);
        Assert.Equal(0, failure.EndLine);
        Assert.Equal(0, failure.EndCharacter);
        Assert.Contains("Bogus.dll", failure.Message, StringComparison.Ordinal);

        // A second pull stays stable: the failure is reported again, not laundered
        // into a clean empty answer once the load result is cached.
        var pulledAgain = await ProjectDiagnosticsAsync(manager, _csprojPath);
        _ = Assert.Single(pulledAgain, diagnostic => diagnostic.Code == "CS8032");

        // The document keeps answering beside the failure — the broken reference
        // never poisons ordinary per-file diagnostics.
        var document = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath);
        Assert.DoesNotContain(document, diagnostic => diagnostic.Code == "CS8032");
    }

    private static async Task<List<DiagnosticResult>> ProjectDiagnosticsAsync(
        WorkspaceManager manager,
        string projectPath
    )
    {
        var result = await manager.GetProjectDiagnosticsAsync(projectPath).ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return result.Match(value => value, _ => []);
    }
}
