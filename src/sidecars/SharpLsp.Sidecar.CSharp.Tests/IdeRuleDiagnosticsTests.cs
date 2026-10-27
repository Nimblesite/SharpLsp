using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

// CA1515: xunit requires public test classes.
#pragma warning disable CA1515

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// IDE code-style rules are diagnostic sources in their own right
/// ([DIAG-CATEGORIES-ANALYZER]: "Built-in Roslyn analyzers — IDE0001–IDE0090" and
/// ".editorconfig rules → analyzer severity"). The editor experience — what C#
/// Dev Kit shows ([AGENTS Aim #1]) — reports an IDE rule promoted by
/// .editorconfig even when the project does not set
/// <c>EnforceCodeStyleInBuild</c>: that property governs the build, not the
/// editor. A rule left at its default hidden severity stays unreported, so
/// defaults never flood the report, and every suppression — .editorconfig
/// <c>none</c>, NoWarn, pragmas, AnalysisMode — still wins.
/// </summary>
public sealed class IdeRuleDiagnosticsTests : IDisposable
{
    private const string Csproj = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup>
            <TargetFramework>net10.0</TargetFramework>
            <OutputType>Library</OutputType>
          </PropertyGroup>
        </Project>
        """;

    private const string PromotedEditorConfig = """
        root = true

        [*.cs]
        dotnet_diagnostic.IDE0040.severity = warning
        """;

    private const string UnconfiguredEditorConfig = """
        root = true

        [*.cs]
        """;

    private const string NoneEditorConfig = """
        root = true

        [*.cs]
        dotnet_diagnostic.IDE0040.severity = none
        """;

    // IDE0040 violation: the field lacks accessibility modifiers.
    private const string Source = """
        namespace Sample;

        public class Greeter
        {
            int _value = 41;
        }
        """;

    private const string SourceName = "Greeter.cs";

    private readonly ProjectlessWorkspaceFixture _files = new("ide-rules");

    public void Dispose()
    {
        _files.Dispose();
    }

    [Fact]
    public async Task An_editorconfig_promoted_IDE0040_warning_is_reported_without_EnforceCodeStyleInBuild()
    {
        using var manager = await OpenAsync("Promoted", PromotedEditorConfig);

        var violation = Assert.Single(
            await DiagnosticsAsync(manager, "Promoted"),
            diagnostic => diagnostic.Code == "IDE0040"
        );
        Assert.Equal("Warning", violation.Severity);
        Assert.Equal(4, violation.StartLine);
        Assert.Equal(8, violation.StartCharacter);
        Assert.Equal(4, violation.EndLine);
        Assert.Equal(14, violation.EndCharacter);
    }

    [Fact]
    public async Task A_rule_at_its_default_hidden_severity_stays_unreported()
    {
        using var manager = await OpenAsync("Defaults", UnconfiguredEditorConfig);

        var diagnostics = await DiagnosticsAsync(manager, "Defaults");

        // The same source violates IDE0040, but nobody promoted the rule: its
        // default hidden severity must keep it out of the report.
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Code == "IDE0040");
        // No hidden-severity diagnostic may ever reach the editor.
        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.Severity == "Hidden");
    }

    [Fact]
    public async Task An_editorconfig_severity_of_none_silences_the_IDE_rule()
    {
        using var manager = await OpenAsync("Silenced", NoneEditorConfig);

        Assert.DoesNotContain(
            await DiagnosticsAsync(manager, "Silenced"),
            diagnostic => diagnostic.Code == "IDE0040"
        );
    }

    private async Task<WorkspaceManager> OpenAsync(string projectDirectory, string editorConfig)
    {
        var projectPath = _files.Write(NativePaths.Join(projectDirectory, "Ide.csproj"), Csproj);
        _ = _files.Write(NativePaths.Join(projectDirectory, ".editorconfig"), editorConfig);
        _ = _files.Write(NativePaths.Join(projectDirectory, SourceName), Source);
        var manager = new WorkspaceManager();
        var opened = await ProjectlessWorkspaceFixture
            .OpenAsync(manager, projectPath)
            .ConfigureAwait(false);
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        return manager;
    }

    private async Task<List<DiagnosticResult>> DiagnosticsAsync(
        WorkspaceManager manager,
        string projectDirectory
    )
    {
        return await ProjectlessWorkspaceFixture
            .DiagnosticsAsync(manager, NativePaths.Join(_files.Root, projectDirectory, SourceName))
            .ConfigureAwait(false);
    }
}
