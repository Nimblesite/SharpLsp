using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Tests for the Roslyn dead-code analyzer (<c>SLSPC0101</c>) and its
/// <c>ConfigureAnalyzers</c> gate — the C# half of the cross-language monorepo
/// dead-code feature ([ANALYZERS-UNUSED-PUBLIC], [ANALYZERS-DEADCODE-SEVERITY]).
/// </summary>
public sealed class DeadCodeAnalyzerTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-deadcode-{Guid.NewGuid():N}"
    );

    // A self-contained project with deliberate dead and live symbols:
    //   Helper   — called by Caller            → ALIVE
    //   Caller   — called by Run               → ALIVE
    //   Run      — public, never called        → dead public
    //   Orphan   — public, never called        → dead public
    //   Hidden   — private, never called       → dead private
    //   Secret   — internal, never called      → dead internal
    //   Decorated— [Obsolete], never called    → SKIPPED (attributed)
    //   DeadProp — public, never read          → dead public property
    //   Ghost    — public type, never used     → dead public type
    //   Derived.Poly — override                → SKIPPED (indirect contract)
    private const string Source =
        "namespace S;\n\n"
        + "public class Base { public virtual int Poly() => 0; }\n\n"
        + "public class Derived : Base { public override int Poly() => 1; }\n\n"
        + "public interface IFace { int M(); }\n\n"
        + "public class Impl : IFace { int IFace.M() => 0; }\n\n"
        + "public interface IGone { }\n\n"
        + "public struct DeadStruct { }\n\n"
        + "public enum DeadEnum { A }\n\n"
        + "public class Host { protected int Prot() => 0; }\n\n"
        + "public static class Api\n"
        + "{\n"
        + "    public static int Helper() => 1;\n"
        + "    public static int Orphan() => 2;\n"
        + "    private static int Hidden() => 3;\n"
        + "    internal static int Secret() => 4;\n"
        + "    public static int Caller() => Helper();\n"
        + "    public static int Run() => Caller();\n"
        + "    public static int Main() => 0;\n"
        + "    [System.Obsolete]\n"
        + "    public static int Decorated() => 5;\n"
        + "    public static int DeadProp => 9;\n"
        + "}\n\n"
        + "public class Ghost { }\n";

    public DeadCodeAnalyzerTests()
    {
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    private string WriteProjectFiles()
    {
        const string csproj = """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
            </Project>
            """;
        var csprojPath = Path.Combine(_root, "Dead.csproj");
        File.WriteAllText(csprojPath, csproj);
        File.WriteAllText(Path.Combine(_root, "Dead.cs"), Source);
        return csprojPath;
    }

    private async Task<WorkspaceManager> LoadAsync()
    {
        var csprojPath = WriteProjectFiles();
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(csprojPath).ConfigureAwait(false);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        return manager;
    }

    private async Task<List<DiagnosticResult>> DeadDiagnosticsAsync(WorkspaceManager manager)
    {
        var sourcePath = Path.Combine(_root, "Dead.cs");
        var result = await manager.GetDiagnosticsAsync(sourcePath).ConfigureAwait(false);
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        var all = result.Match(value => value, _ => new List<DiagnosticResult>());
        return [.. all.Where(d => d.Code == DeadCodeAnalyzer.DiagnosticCode)];
    }

    private static DiagnosticResult? ByName(List<DiagnosticResult> diags, string symbol)
    {
        return diags.Find(d => d.Message.Contains(symbol));
    }

    [Fact]
    public async Task Without_configure_no_dead_code_diagnostics_are_emitted()
    {
        using var manager = await LoadAsync();
        // Analyzer defaults off until the host configures it.
        var dead = await DeadDiagnosticsAsync(manager);
        Assert.Empty(dead);
    }

    [Fact]
    public async Task NonMonorepo_reports_private_and_internal_dead_code_as_warnings()
    {
        using var manager = await LoadAsync();
        manager.ConfigureAnalyzers(deadCode: true, monorepo: false);
        var dead = await DeadDiagnosticsAsync(manager);

        var hidden = ByName(dead, "Hidden");
        Assert.NotNull(hidden);
        Assert.Equal("Warning", hidden!.Severity);
        Assert.Equal("SLSPC0101", hidden.Code);
        Assert.Contains("Dead code", hidden.Message);
        Assert.Contains("method", hidden.Message);

        var secret = ByName(dead, "Secret");
        Assert.NotNull(secret);
        Assert.Equal("Warning", secret!.Severity);

        // Public deadness is suppressed without the monorepo opt-in.
        Assert.Null(ByName(dead, "Orphan"));
        Assert.Null(ByName(dead, "Run"));
        Assert.Null(ByName(dead, "Ghost"));
    }

    [Fact]
    public async Task Monorepo_reports_unused_public_symbols_as_errors()
    {
        using var manager = await LoadAsync();
        manager.ConfigureAnalyzers(deadCode: true, monorepo: true);
        var dead = await DeadDiagnosticsAsync(manager);

        var orphan = ByName(dead, "Orphan");
        Assert.NotNull(orphan);
        Assert.Equal("Error", orphan!.Severity);
        Assert.Contains("Public", orphan.Message);
        Assert.Contains("monorepo", orphan.Message);

        // Private deadness escalates to an error in monorepo mode too.
        var hidden = ByName(dead, "Hidden");
        Assert.NotNull(hidden);
        Assert.Equal("Error", hidden!.Severity);

        // The dead public type, orphan binding, and property are all flagged.
        Assert.NotNull(ByName(dead, "Run"));
        Assert.NotNull(ByName(dead, "Ghost"));
        Assert.NotNull(ByName(dead, "DeadProp"));

        // Dead public types are labelled by their kind.
        Assert.Contains("interface", ByName(dead, "IGone")!.Message);
        Assert.Contains("struct", ByName(dead, "DeadStruct")!.Message);
        Assert.Contains("enum", ByName(dead, "DeadEnum")!.Message);
    }

    [Fact]
    public async Task Live_attributed_and_referenced_symbols_are_never_flagged()
    {
        using var manager = await LoadAsync();
        manager.ConfigureAnalyzers(deadCode: true, monorepo: true);
        var dead = await DeadDiagnosticsAsync(manager);

        // Referenced symbols are alive.
        Assert.Null(ByName(dead, "Helper"));
        Assert.Null(ByName(dead, "Caller"));
        // Attributed members are reflection-reachable → skipped.
        Assert.Null(ByName(dead, "Decorated"));
        // Entry points, protected members, and explicit interface impls are skipped.
        Assert.Null(ByName(dead, "Main"));
        Assert.Null(ByName(dead, "Prot"));
    }

    [Fact]
    public async Task Disabling_the_analyzer_suppresses_dead_code_even_in_monorepo()
    {
        using var manager = await LoadAsync();
        manager.ConfigureAnalyzers(deadCode: false, monorepo: true);
        var dead = await DeadDiagnosticsAsync(manager);
        Assert.Empty(dead);
    }
}
