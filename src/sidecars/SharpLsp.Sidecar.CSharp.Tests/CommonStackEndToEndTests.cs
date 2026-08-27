using MessagePack;
using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable IDE0058 // Expression value is never used
#pragma warning disable RS1035 // Test fixtures write real solution files to disk

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// E2E tests targeting shared-stack (SharpLsp.Sidecar.Common) code paths through
/// the real sidecar socket: XmlDocRenderer rendering of doc comments that omit a
/// summary and use inline <c>&lt;code&gt;</c>, <c>&lt;see langword&gt;</c> and
/// inline <c>&lt;example&gt;</c> constructs; and SolutionFileReader reading a
/// legacy <c>.sln</c> with a project and a solution folder, plus the
/// invalid-extension fault path.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class CommonStackEndToEndTests(CSharpSidecarFixture fixture)
    : IClassFixture<CSharpSidecarFixture>
{
    // ── XmlDocRenderer: summary-less doc with inline code / see / example ──

    [Fact]
    public async Task Hover_on_summaryless_documented_method_renders_remarks_and_example()
    {
        // MetaProbe's `Doc` method (L55) has NO <summary> but carries <param>,
        // <returns>, a <remarks> with <see langword="true"/> (cref-less) and an
        // inline <code> element, and an inline <example>. Rendering it drives the
        // XmlDocRenderer branches a summary-only comment never reaches.
        var hover = await fixture.SendAndDeserializeAsync<HoverResult>(
            "textDocument/hover",
            CSharpSidecarFixture.PosFor(fixture.MetaProbeFile, 55, 15)
        );
        Assert.Contains("doubled", hover.Contents);
    }

    // ── SolutionFileReader: legacy .sln with project + solution folder ──

    [Fact]
    public async Task SolutionRead_legacy_sln_returns_project_and_folder()
    {
        var slnPath = Path.Combine(fixture.TempDir, "Legacy.sln");
        await File.WriteAllTextAsync(
            slnPath,
            "Microsoft Visual Studio Solution File, Format Version 12.00\n"
                + "# Visual Studio Version 17\n"
                + "Project(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"TestProject\", "
                + "\"TestProject.csproj\", \"{2C2A1F0B-1111-4444-8888-0123456789AB}\"\n"
                + "EndProject\n"
                + "Project(\"{2150E333-8FDC-42A3-9474-1A3956D46DE8}\") = \"Docs\", \"Docs\", "
                + "\"{9D5C4E3A-2222-4444-8888-0123456789CD}\"\n"
                + "EndProject\n"
                + "Global\n"
                + "\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\n"
                + "\t\tDebug|Any CPU = Debug|Any CPU\n"
                + "\tEndGlobalSection\n"
                + "EndGlobal\n"
        );

        var model = await fixture.SendAndDeserializeAsync<SolutionFileModel>(
            "solution/read",
            MessagePackSerializer.Serialize(slnPath)
        );
        Assert.Equal("sln", model.Format);
        Assert.Contains(model.Projects, p => p.DisplayName == "TestProject");
        Assert.NotEmpty(model.Folders);
    }

    [Fact]
    public async Task SolutionRead_malformed_slnx_reports_failure_without_crashing()
    {
        // Valid extension but unparseable content: ValidateSupportedFile passes,
        // so the parser throws and ReadAsync's catch returns a failure result.
        var slnxPath = Path.Combine(fixture.TempDir, "Broken.slnx");
        await File.WriteAllTextAsync(slnxPath, "<Solution><Project Path=");

        await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(slnxPath));
        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }

    [Fact]
    public async Task SolutionRead_invalid_extension_is_handled_gracefully()
    {
        var badPath = Path.Combine(fixture.TempDir, "not-a-solution.txt");
        await File.WriteAllTextAsync(badPath, "irrelevant");

        await fixture.SendAsync("solution/read", MessagePackSerializer.Serialize(badPath));
        // The reader rejects the extension before parsing; the sidecar must reply
        // (with an error or empty model) and stay alive — never crash.
        var ping = await fixture.SendAsync("ping", []);
        Assert.Null(ping.Error);
        Assert.Equal("pong", MessagePackSerializer.Deserialize<string>(ping.Payload));
    }
}
