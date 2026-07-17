using System.Diagnostics;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison for Assert.Contains
#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath / Process banned for analyzers — we're tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Coarse e2e coverage for [DEFINITION-CROSSLANG]: a C# project that references
/// an F# project. Roslyn's <c>MSBuildWorkspace</c> has no F# language service,
/// so it loads the referenced <c>.fsproj</c> as an EMPTY stub project whose
/// type-less compilation shadows the real built DLL and breaks go-to-definition
/// into F#. <see cref="WorkspaceManager"/> rewires each cross-language reference
/// to a metadata reference against the F# project's built output assembly (and
/// its sibling DLLs, e.g. FSharp.Core) and drops the empty stub, so the F# type
/// resolves from the C# side. This test builds a REAL F# library, references it
/// from a REAL C# project, loads the C# project through the sidecar's
/// <c>WorkspaceManager</c> (MSBuildWorkspace pulls in the referenced project),
/// and asserts the F# type is navigable — which it is ONLY if the rewiring ran.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2007:Consider calling ConfigureAwait on the awaited task",
    Justification = "xUnit test methods run on the synchronization-context-free test pool"
)]
public sealed class WorkspaceManagerCrossLanguageCoverageTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-wm-xlang-{Guid.NewGuid():N}"
    );
    private readonly string _appCsprojPath;
    private readonly string _programPath;

    public WorkspaceManagerCrossLanguageCoverageTests()
    {
        var libDir = Path.Combine(_root, "Lib");
        var appDir = Path.Combine(_root, "App");
        Directory.CreateDirectory(libDir);
        Directory.CreateDirectory(appDir);

        File.WriteAllText(
            Path.Combine(libDir, "Lib.fsproj"),
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
              <ItemGroup>
                <Compile Include="Library.fs" />
              </ItemGroup>
            </Project>
            """
        );
        File.WriteAllText(
            Path.Combine(libDir, "Library.fs"),
            "namespace FsLib\n\ntype Widget() =\n    member _.Value = 42\n"
        );

        _appCsprojPath = Path.Combine(appDir, "App.csproj");
        File.WriteAllText(
            _appCsprojPath,
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
                <OutputType>Library</OutputType>
              </PropertyGroup>
              <ItemGroup>
                <ProjectReference Include="..\Lib\Lib.fsproj" />
              </ItemGroup>
            </Project>
            """
        );
        _programPath = Path.Combine(appDir, "Program.cs");
        File.WriteAllText(
            _programPath,
            "namespace App;\n"
                + "\n"
                + "public static class Program\n"
                + "{\n"
                + "    public static int Use()\n"
                + "    {\n"
                + "        var widget = new FsLib.Widget();\n"
                + "        return widget.Value;\n"
                + "    }\n"
                + "}\n"
        );

        // Build through the C# project so its F# ProjectReference is built too:
        // the rewiring can only attach the F# output DLL if that DLL exists.
        BuildProject(_appCsprojPath);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    [Fact]
    public async Task Loading_a_CSharp_project_that_references_FSharp_resolves_the_FSharp_type()
    {
        using var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Obsolete OpenAsync placeholder
        var open = await manager.OpenAsync(_appCsprojPath);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", err => err));
        Assert.True(manager.IsLoaded, "cross-language workspace must load");

        // `Widget` in `new FsLib.Widget()` is an F# type. Without the metadata
        // rewiring it binds to the empty stub project and go-to-definition finds
        // nothing; with it, the symbol resolves and MetadataNavigator decompiles
        // the F# assembly to a navigable location.
        var (line, character) = LocateToken(_programPath, "new FsLib.Widget", "Widget");
        var locations = AssertOk(await manager.GetDefinitionAsync(_programPath, line, character));
        Assert.NotEmpty(locations.Locations);
        Assert.All(locations.Locations, loc => Assert.False(string.IsNullOrEmpty(loc.FilePath)));
    }

    /// <summary>Assert the query succeeded and return its success value.</summary>
    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", err => err));
        return +result;
    }

    /// <summary>Locate a token on the first line containing <paramref name="lineAnchor"/>.</summary>
    private static (int Line, int Character) LocateToken(
        string filePath,
        string lineAnchor,
        string token
    )
    {
        var lines = File.ReadAllLines(filePath);
        for (var i = 0; i < lines.Length; i++)
        {
            if (!lines[i].Contains(lineAnchor, StringComparison.Ordinal))
            {
                continue;
            }
            var column = lines[i].IndexOf(token, StringComparison.Ordinal);
            if (column >= 0)
            {
                return (i, column);
            }
        }
        throw new InvalidOperationException(
            $"token '{token}' not found near '{lineAnchor}' in {filePath}"
        );
    }

    /// <summary>Build a project (and its project references) with the dotnet CLI.</summary>
    private static void BuildProject(string projectPath)
    {
        var psi = new ProcessStartInfo(
            "dotnet",
            $"build \"{projectPath}\" -c Debug --nologo -v quiet"
        )
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = new Process { StartInfo = psi };
        process.Start();
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"dotnet build must succeed:\n{stdout}\n{stderr}");
    }
}
