using System.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1307 // StringComparison overloads add no value to xUnit assertions
#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Setup calls intentionally ignore their return values
#pragma warning disable RS1035 // Real-process/temp-path use is intentional in this coarse E2E

namespace SharpLsp.Sidecar.CSharp.Tests;

public sealed class WorkspaceManagerForeignRenameTests : IClassFixture<ForeignRenameFixture>
{
    private readonly ForeignRenameFixture _fixture;

    public WorkspaceManagerForeignRenameTests(ForeignRenameFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task Real_mixed_workspace_exposes_CSharp_identity_and_rejects_keyword_position()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var (line, character) = _fixture.Locate("public sealed class CSharpOrigin", "CSharpOrigin");
        var identity = AssertOk(
            await manager.GetRenameIdentityAsync(_fixture.SourcePath, line, character)
        );
        Assert.True(identity.Found);
        Assert.Equal("App", identity.AssemblyName);
        Assert.Equal("T:App.CSharpOrigin", identity.XmlDocSig);

        var absent = AssertOk(await manager.GetRenameIdentityAsync(_fixture.SourcePath, line, 0));
        Assert.False(absent.Found);
        Assert.Equal("", absent.AssemblyName);
        Assert.Equal("", absent.XmlDocSig);
    }

    [Fact]
    public async Task Real_FSharp_metadata_symbol_produces_every_granular_CSharp_reference_edit()
    {
        using var manager = await _fixture.OpenManagerAsync();
        var result = AssertOk(
            await manager.RenameForeignAsync("Lib", "T:FsLib.Widget", "RenamedWidget")
        );
        var document = Assert.Single(result.DocumentChanges);
        AssertForwardDocument(document);
        await AssertRejectedForeignRenameAsync(manager, "Wrong", "T:FsLib.Widget", "Nope");
        await AssertRejectedForeignRenameAsync(manager, "Lib", "T:FsLib.Widget", "bad-name");
    }

    [Fact]
    public async Task Repository_mixed_solution_resolves_the_exact_FSharp_identity_into_CSharp()
    {
        var workspace = FindRepositoryFixture();
        await EnsureFSharpFixtureBuiltAsync(workspace);
        var sourcePath = Path.Combine(workspace, "crosslanguage", "FSharpConsumer.cs");
        using var manager = await OpenRepositoryManagerAsync(workspace);
        var (line, character) = LocateFile(sourcePath, "Read(FSharpOrigin", "FSharpOrigin");
        Assert.NotEmpty(
            AssertOk(await manager.GetDefinitionAsync(sourcePath, line, character)).Locations
        );
        var edit = AssertOk(
            await manager.RenameForeignAsync(
                "FSharpFixtures",
                "T:FSharpFixtures.CrossLanguage.FSharpOrigin",
                "RenamedFSharpOrigin"
            )
        );
        Assert.Equal(sourcePath, Assert.Single(edit.DocumentChanges).FilePath);
    }

    [Fact]
    public async Task Request_local_projection_reverses_a_fresh_unsaved_overlay_exactly()
    {
        var (baseline, forward, renamed) = await CreateForwardOverlayAsync();
        using var reverseManager = await _fixture.OpenManagerAsync();
        _ = AssertOk(await reverseManager.UpdateDocumentTextAsync(_fixture.SourcePath, renamed));
        var reverse = await RenameWidgetAsync(reverseManager, "T:FsLib.RenamedWidget", "Widget");
        AssertEditsReplace(renamed, reverse.Edits, "RenamedWidget", "Widget", 4);
        Assert.Equal(baseline, ApplyEdits(renamed, reverse.Edits));
        AssertProjectedCoordinates(forward.Edits, reverse.Edits);
    }

    private static void AssertProjectedCoordinates(
        List<TextEditResult> forward,
        List<TextEditResult> reverse
    )
    {
        Assert.Equal(
            forward.Select(edit => edit.StartLine),
            reverse.Select(edit => edit.StartLine)
        );
        Assert.Equal(forward[0].StartCharacter, reverse[0].StartCharacter);
        Assert.Equal(forward[1].StartCharacter, reverse[1].StartCharacter);
        Assert.Equal(forward[2].StartCharacter, reverse[2].StartCharacter);
        Assert.Equal(forward[3].StartCharacter + 7, reverse[3].StartCharacter);
    }

    [Fact]
    public async Task Request_local_projection_rejects_unbound_same_name_candidates()
    {
        var (_, _, renamed) = await CreateForwardOverlayAsync();
        using var manager = await _fixture.OpenManagerAsync();
        var stale = TamperForeignReferences(renamed);
        Assert.Equal(3, CountOccurrences(stale, "RenamedWidget"));
        Assert.Equal(4, CountOccurrences(stale, "TamperedWidget"));
        _ = AssertOk(await manager.UpdateDocumentTextAsync(_fixture.SourcePath, stale));

        var result = AssertOk(
            await manager.RenameForeignAsync("Lib", "T:FsLib.RenamedWidget", "Widget")
        );
        Assert.Empty(result.DocumentChanges);
        Assert.Contains("public sealed class RenamedWidget", stale);
        Assert.Contains("new RenamedWidget()", stale);
        Assert.Contains("nameof(RenamedWidget)", stale);
    }

    private static string TamperForeignReferences(string renamed)
    {
        return renamed.Replace(
            "FsLib.RenamedWidget",
            "FsLib.TamperedWidget",
            StringComparison.Ordinal
        );
    }

    private async Task<(
        string Baseline,
        DocumentEditResult Forward,
        string Renamed
    )> CreateForwardOverlayAsync()
    {
        var baseline = await File.ReadAllTextAsync(_fixture.SourcePath);
        using var manager = await _fixture.OpenManagerAsync();
        var forward = await RenameWidgetAsync(manager, "T:FsLib.Widget", "RenamedWidget");
        AssertEditsReplace(baseline, forward.Edits, "Widget", "RenamedWidget", 4);
        var renamed = ApplyEdits(baseline, forward.Edits);
        Assert.NotEqual(baseline, renamed);
        Assert.Equal(7, CountOccurrences(renamed, "RenamedWidget"));
        return (baseline, forward, renamed);
    }

    private void AssertForwardDocument(DocumentEditResult document)
    {
        Assert.Equal(_fixture.SourcePath, document.FilePath);
        Assert.Equal(4, document.Edits.Count);
        Assert.All(document.Edits, edit => Assert.Equal("RenamedWidget", edit.NewText));
        Assert.All(document.Edits, _fixture.AssertReplacesWidget);
        Assert.Equal(4, document.Edits.Select(EditKey).Distinct().Count());
    }

    private static async Task AssertRejectedForeignRenameAsync(
        WorkspaceManager manager,
        string assemblyName,
        string xmlDocSig,
        string newName
    )
    {
        var result = AssertOk(await manager.RenameForeignAsync(assemblyName, xmlDocSig, newName));
        Assert.Empty(result.DocumentChanges);
    }

    private static async Task<WorkspaceManager> OpenRepositoryManagerAsync(string workspace)
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // Exercise the real solution-loading boundary
        var opened = await manager.OpenAsync(Path.Combine(workspace, "TestFixtures.slnx"));
#pragma warning restore CS0618
        Assert.False(opened.IsError, opened.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded);
        return manager;
    }

    private static async Task<DocumentEditResult> RenameWidgetAsync(
        WorkspaceManager manager,
        string xmlDocSig,
        string newName
    )
    {
        var result = AssertOk(await manager.RenameForeignAsync("Lib", xmlDocSig, newName));
        return Assert.Single(result.DocumentChanges);
    }

    private static void AssertEditsReplace(
        string source,
        List<TextEditResult> edits,
        string oldName,
        string newName,
        int count
    )
    {
        Assert.Equal(count, edits.Count);
        Assert.All(edits, edit => Assert.Equal(newName, edit.NewText));
        Assert.All(edits, edit => Assert.Equal(oldName, TextAtEdit(source, edit)));
        Assert.Equal(count, edits.Select(EditKey).Distinct().Count());
    }

    private static string ApplyEdits(string source, IEnumerable<TextEditResult> edits)
    {
        var sourceText = SourceText.From(source);
        foreach (var edit in edits.OrderByDescending(item => EditSpan(sourceText, item).Start))
        {
            var span = EditSpan(sourceText, edit);
            source = source.Remove(span.Start, span.Length).Insert(span.Start, edit.NewText);
        }
        return source;
    }

    private static string TextAtEdit(string source, TextEditResult edit)
    {
        var sourceText = SourceText.From(source);
        return sourceText.ToString(EditSpan(sourceText, edit));
    }

    private static int CountOccurrences(string source, string value)
    {
        return source.Split(value, StringSplitOptions.None).Length - 1;
    }

    private static TextSpan EditSpan(SourceText source, TextEditResult edit)
    {
        var start = source.Lines.GetPosition(new LinePosition(edit.StartLine, edit.StartCharacter));
        var end = source.Lines.GetPosition(new LinePosition(edit.EndLine, edit.EndCharacter));
        return TextSpan.FromBounds(start, end);
    }

    private static string EditKey(TextEditResult edit)
    {
        return $"{edit.StartLine}:{edit.StartCharacter}-{edit.EndLine}:{edit.EndCharacter}";
    }

    private static TValue AssertOk<TValue>(Outcome.Result<TValue, string> result)
    {
        Assert.False(result.IsError, result.Match(_ => "ok", error => error));
        return +result;
    }

    private static readonly SemaphoreSlim FixtureBuildGate = new(1, 1);
    private static bool _fSharpFixtureBuilt;

    /// <summary>
    /// Build the F# fixture assembly that the mixed-language solution binds against.
    ///
    /// Roslyn's MSBuildWorkspace cannot load an <c>.fsproj</c>, so
    /// <c>CSharpConsumer</c>'s project reference degrades to a metadata reference
    /// resolved from the F# project's build output on disk. With no assembly there
    /// <c>FSharpOrigin</c> never binds, the foreign rename matches nothing, and the
    /// document-change assertion fails — but only on a machine that has not already
    /// built the fixture, which is every clean checkout, CI included. Building it
    /// here makes the test independent of ambient build state.
    ///
    /// The configuration is pinned to Debug rather than inherited: MSBuildWorkspace
    /// opens the solution under MSBuild's default configuration, so Debug is where
    /// it looks for the reference no matter how this test assembly was built.
    /// </summary>
    private static async Task EnsureFSharpFixtureBuiltAsync(string workspace)
    {
        await FixtureBuildGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_fSharpFixtureBuilt)
            {
                return;
            }

            var project = Path.Combine(workspace, "fsharp", "FSharpFixtures.fsproj");
            var (exitCode, output) = await RunDotnetBuildAsync(project).ConfigureAwait(false);
            Assert.True(exitCode == 0, $"F# fixture build failed ({exitCode}):{output}");
            _fSharpFixtureBuilt = true;
        }
        finally
        {
            FixtureBuildGate.Release();
        }
    }

    /// <summary>Build one project, returning its exit code and merged output.</summary>
    private static async Task<(int ExitCode, string Output)> RunDotnetBuildAsync(string project)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            ArgumentList = { "build", project, "--configuration", "Debug", "--nologo" },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var build = Process.Start(startInfo);
        Assert.NotNull(build);
        // Drain both pipes concurrently: reading them in sequence deadlocks as soon
        // as the un-read pipe fills its buffer.
        var stdout = build.StandardOutput.ReadToEndAsync();
        var stderr = build.StandardError.ReadToEndAsync();
        await build.WaitForExitAsync().ConfigureAwait(false);
        var text = await stdout.ConfigureAwait(false) + await stderr.ConfigureAwait(false);
        return (build.ExitCode, text);
    }

    private static string FindRepositoryFixture()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = RepositoryFixtureCandidate(directory.FullName);
            if (File.Exists(Path.Combine(candidate, "TestFixtures.slnx")))
            {
                return candidate;
            }
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("SharpLsp repository fixture was not found");
    }

    private static string RepositoryFixtureCandidate(string directory)
    {
        return Path.Combine(directory, "src", "editors", "vscode", "test-fixtures", "workspace");
    }

    private static (int Line, int Character) LocateFile(string path, string anchor, string token)
    {
        var lines = File.ReadAllLines(path);
        var line = Array.FindIndex(
            lines,
            value => value.Contains(anchor, StringComparison.Ordinal)
        );
        Assert.True(line >= 0, $"missing line anchor {anchor}");
        var character = lines[line].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"missing token {token}");
        return (line, character);
    }
}

public sealed class ForeignRenameFixture : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-foreign-rename-{Guid.NewGuid():N}"
    );

    public ForeignRenameFixture()
    {
        var libDirectory = Path.Combine(_root, "Lib");
        var appDirectory = Path.Combine(_root, "App");
        Directory.CreateDirectory(libDirectory);
        Directory.CreateDirectory(appDirectory);
        WriteFSharpLibrary(libDirectory);
        ProjectPath = WriteCSharpConsumer(appDirectory, libDirectory);
        SourcePath = Path.Combine(appDirectory, "Program.cs");
        WriteConsumerSource(SourcePath);
        BuildProject(ProjectPath);
    }

    public string ProjectPath { get; }

    public string SourcePath { get; }

    internal async Task<WorkspaceManager> OpenManagerAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // OpenAsync remains the real workspace-loading boundary
        var open = await manager.OpenAsync(ProjectPath);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", error => error));
        Assert.True(manager.IsLoaded);
        return manager;
    }

    public (int Line, int Character) Locate(string lineAnchor, string token)
    {
        var lines = File.ReadAllLines(SourcePath);
        var line = Array.FindIndex(
            lines,
            value => value.Contains(lineAnchor, StringComparison.Ordinal)
        );
        Assert.True(line >= 0, $"missing line anchor {lineAnchor}");
        var character = lines[line].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"missing token {token}");
        return (line, character);
    }

    internal void AssertReplacesWidget(TextEditResult edit)
    {
        Assert.Equal(edit.StartLine, edit.EndLine);
        Assert.Equal("Widget".Length, edit.EndCharacter - edit.StartCharacter);
        var line = File.ReadAllLines(SourcePath)[edit.StartLine];
        Assert.Equal("Widget", line.Substring(edit.StartCharacter, "Widget".Length));
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    private static void WriteFSharpLibrary(string directory)
    {
        File.WriteAllText(Path.Combine(directory, "Lib.fsproj"), FSharpProject);
        File.WriteAllText(
            Path.Combine(directory, "Library.fs"),
            "namespace FsLib\n\ntype Widget() =\n    member _.Value = 42\n"
        );
    }

    private static string WriteCSharpConsumer(string directory, string libDirectory)
    {
        var projectPath = Path.Combine(directory, "App.csproj");
        var relativeReference = Path.GetRelativePath(
            directory,
            Path.Combine(libDirectory, "Lib.fsproj")
        );
        File.WriteAllText(projectPath, CSharpProject.Replace("$REFERENCE$", relativeReference));
        return projectPath;
    }

    private static void WriteConsumerSource(string path)
    {
        File.WriteAllText(path, ConsumerSource);
    }

    private static void BuildProject(string projectPath)
    {
        var startInfo = new ProcessStartInfo("dotnet", $"build \"{projectPath}\" --nologo -v quiet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process =
            Process.Start(startInfo) ?? throw new InvalidOperationException("dotnet did not start");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, $"real mixed build failed:\n{stdout}\n{stderr}");
    }

    private const string FSharpProject = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
          <ItemGroup><Compile Include="Library.fs" /></ItemGroup>
        </Project>
        """;

    private const string CSharpProject = """
        <Project Sdk="Microsoft.NET.Sdk">
          <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
          <ItemGroup><ProjectReference Include="$REFERENCE$" /></ItemGroup>
        </Project>
        """;

    private const string ConsumerSource = """
        namespace App;

        public sealed class CSharpOrigin { }

        public sealed class RenamedWidget
        {
            public int Value => 99;
        }

        public static class Program
        {
            public static string Use()
            {
                var first = new FsLib.Widget();
                FsLib.Widget second = first;
                return nameof(FsLib.Widget) + typeof(FsLib.Widget).Name + second.Value;
            }

            public static int UseUnrelated()
            {
                var unrelated = new RenamedWidget();
                return unrelated.Value + nameof(RenamedWidget).Length;
            }
        }
        """;
}
