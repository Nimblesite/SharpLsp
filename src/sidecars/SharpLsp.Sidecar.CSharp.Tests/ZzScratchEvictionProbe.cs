using System.Reflection;
using Microsoft.CodeAnalysis;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515, RS1035, IDE0022, CA1802

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class ZzScratchEvictionProbe : IDisposable
{
    private const string PackagedRoot =
        "#:package Newtonsoft.Json@13.0.3\n"
        + "using Newtonsoft.Json.Linq;\n"
        + "var payload = new JObject();\n"
        + "Emit(payload.Count);\n";

    private readonly ProjectlessWorkspaceFixture _fixture = new("probe");

    public void Dispose() => _fixture.Dispose();

    private static T? Field<T>(WorkspaceManager manager, string name)
        where T : class
    {
        var field = typeof(WorkspaceManager).GetField(
            name,
            BindingFlags.NonPublic | BindingFlags.Instance
        );
        return field?.GetValue(manager) as T;
    }

    private const string ProbeLog =
        "/private/tmp/claude-501/-Users-christianfindlay-Documents-Code-SharpLsp/4f4f4f8a-5c2e-484c-8cf6-f588133602f1/scratchpad/probe.txt";

    private static void Emit(string line)
    {
        File.AppendAllText(ProbeLog, line + "\n");
    }

    private static void Report(WorkspaceManager manager, string label)
    {
        var solution = Field<Solution>(manager, "_solution");
        var adhoc = Field<Microsoft.CodeAnalysis.Workspace>(manager, "_adhocWorkspace");
        var adhocSolution = adhoc?.CurrentSolution;
        Emit($"--- {label} ---");
        Emit(
            $"  _solution projects={solution?.Projects.Count()} "
                + $"refs=[{string.Join(",", solution?.Projects.Select(p => $"{p.Name}:{p.MetadataReferences.Count}") ?? [])}]"
        );
        Emit(
            $"  _adhoc    projects={adhocSolution?.Projects.Count()} "
                + $"refs=[{string.Join(",", adhocSolution?.Projects.Select(p => $"{p.Name}:{p.MetadataReferences.Count}") ?? [])}]"
        );
        Emit($"  same instance = {ReferenceEquals(solution, adhocSolution)}");
        DumpDocs("  _solution", solution);
        DumpDocs("  _adhoc   ", adhocSolution);
    }

    private static void DumpDocs(string label, Solution? solution)
    {
        foreach (var project in solution?.Projects ?? [])
        {
            var docs = project.Documents.Select(d =>
                $"{d.Name}({d.GetTextAsync().Result.Length})"
            );
            Emit($"{label} {project.Name}: {string.Join(" ", docs)}");
        }
    }

    [Fact]
    public async Task Probe()
    {
        var packaged = _fixture.Write("RootWithPackage.cs", PackagedRoot);
        using var manager = new WorkspaceManager();
        _ = await ProjectlessWorkspaceFixture.OpenAsync(manager, packaged);
        Report(manager, "after open, before buffer push");

        _ = await manager.UpdateDocumentTextAsync(packaged, PackagedRoot + "Emit(payload.Type);\n");
        Report(manager, "after buffer push, restore still in flight");

        _ = await ProjectlessWorkspaceFixture.SettledDiagnosticsAsync(manager, packaged);
        Report(manager, "after restore settled");

        var plain = _fixture.Write("RootWithoutPackage.cs", "Emit(1);\n");
        _ = await ProjectlessWorkspaceFixture.OpenAsync(manager, plain);
        Report(manager, "after neighbour opened");

        var errors = await ProjectlessWorkspaceFixture.ErrorsAsync(manager, packaged);
        Emit(
            $"  packaged errors = {string.Join(" | ", errors.Select(e => e.Code + ": " + e.Message))}"
        );
    }
}
