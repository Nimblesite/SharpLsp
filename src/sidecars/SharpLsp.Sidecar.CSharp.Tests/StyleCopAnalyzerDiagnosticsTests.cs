using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes. RS1035: real filesystem and real
// dotnet restore are intentional — the repo mandates real files and real packages.
#pragma warning disable CA1515, RS1035

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Third-party NuGet analyzer diagnostics — StyleCop here, the canonical external
/// analyzer — must reach a document's diagnostics with their exact id, severity
/// and range ([DIAG-CATEGORIES-ANALYZER]: "Third-party NuGet analyzers — StyleCop,
/// SonarAnalyzer, etc."). Proven on a real project restored against the real
/// <c>StyleCop.Analyzers</c> package: SA1600 documentation violations are reported
/// exactly as StyleCop computes them — one per undocumented element, on the
/// element's identifier span.
/// </summary>
public sealed class StyleCopAnalyzerDiagnosticsTests : IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
          </PropertyGroup>
          <ItemGroup>
            <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" />
          </ItemGroup>
        </Project>
        """;

    private const string EditorConfig = """
        root = true

        [*.cs]
        dotnet_diagnostic.SA1600.severity = warning
        """;

    // Both elements are undocumented: SA1600 fires on the class and the method.
    private const string Source = """
        namespace Sample;

        public class Greeter
        {
            public int Compute() => 41;
        }
        """;

    private readonly ProjectlessWorkspaceFixture _files = new("stylecop");
    private readonly string _csprojPath;
    private readonly string _sourcePath;

    public StyleCopAnalyzerDiagnosticsTests()
    {
        _csprojPath = _files.Write("StyleCop.csproj", Csproj);
        _ = _files.Write(".editorconfig", EditorConfig);
        _sourcePath = _files.Write("Greeter.cs", Source);
        var (exitCode, output) = DotnetBuild.Restore(_csprojPath);
        Assert.True(exitCode == 0, $"dotnet restore must succeed: {output}");
    }

    public void Dispose()
    {
        _files.Dispose();
    }

    [Fact]
    public async Task A_StyleCop_SA1600_violation_is_reported_with_exact_id_severity_and_range()
    {
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, _csprojPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        var diagnostics = await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, _sourcePath);

        var classViolation = Assert.Single(
            diagnostics,
            diagnostic => diagnostic.Code == "SA1600" && diagnostic.StartLine == 2
        );
        Assert.Equal("Warning", classViolation.Severity);
        Assert.Equal(13, classViolation.StartCharacter);
        Assert.Equal(2, classViolation.EndLine);
        Assert.Equal(20, classViolation.EndCharacter);

        // The undocumented method violates the same rule: StyleCop reports each
        // element, on the element's identifier span.
        var methodViolation = Assert.Single(
            diagnostics,
            diagnostic => diagnostic.Code == "SA1600" && diagnostic.StartLine == 4
        );
        Assert.Equal("Warning", methodViolation.Severity);
        Assert.Equal(15, methodViolation.StartCharacter);
        Assert.Equal(4, methodViolation.EndLine);
        Assert.Equal(22, methodViolation.EndCharacter);
    }
}
