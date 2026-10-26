using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// An analyzer diagnostic must carry its rule's documentation link — the
/// descriptor's <c>HelpLinkUri</c> — so the editor can link the finding to its
/// rule page exactly as the official C# extension does
/// ([DIAG-CATEGORIES-ANALYZER]; LSP <c>Diagnostic.codeDescription.href</c>).
/// Proven on a real project whose .editorconfig promotes CA1822.
/// </summary>
public sealed class AnalyzerHelpLinkTests : IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
            <EnableNETAnalyzers>true</EnableNETAnalyzers>
          </PropertyGroup>
        </Project>
        """;

    private const string EditorConfig = """
        root = true

        [*.cs]
        dotnet_diagnostic.CA1822.severity = error
        """;

    private const string Source = """
        namespace Sample;

        public class Greeter
        {
            public int Compute() => 41;
        }
        """;

    private readonly ProjectlessWorkspaceFixture _files = new("help-link");

    public void Dispose()
    {
        _files.Dispose();
    }

    [Fact]
    public async Task A_reported_analyzer_diagnostic_carries_its_rules_documentation_link()
    {
        var projectPath = _files.Write("HelpLink.csproj", Csproj);
        _ = _files.Write(".editorconfig", EditorConfig);
        var sourcePath = _files.Write("Greeter.cs", Source);
        using var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture.OpenAsync(manager, projectPath);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));

        var violation = Assert.Single(
            await ProjectlessWorkspaceFixture.DiagnosticsAsync(manager, sourcePath),
            diagnostic => diagnostic.Code == "CA1822"
        );

        Assert.Equal(
            "https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1822",
            violation.HelpLink
        );
    }
}
