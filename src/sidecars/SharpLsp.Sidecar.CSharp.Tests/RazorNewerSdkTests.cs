using MessagePack;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0042 // Positions read better as (Line, Character) pairs
#pragma warning disable RS1035 // Real-file writes are intentional: a compiler that cannot be read

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Razor C# features for a user whose newest SDK is newer than the sidecar's Roslyn, with no
/// <c>global.json</c> (#399), against the real fixture solution. Implements [RAZOR-TESTING]
/// for [RAZOR-ARCHITECTURE-GENERATOR].
/// </summary>
public sealed class RazorNewerSdkTests(NewerSdkRazorFixture newer, RazorFixture current)
    : IClassFixture<NewerSdkRazorFixture>,
        IClassFixture<RazorFixture>
{
    private RazorFixture Razor => newer.Razor;

    /// <summary>
    /// The sidecar as the host runs it, in a process of its own. This test process loaded the
    /// sidecar's Razor compiler before any test ran, so only a fresh process meets the SDK's
    /// generator before its own copy is loaded.
    /// </summary>
    [Fact]
    public async Task Razor_csharp_features_answer_when_the_sdk_generator_needs_a_newer_roslyn()
    {
        await using var sidecar = await ExternalSidecar.StartAsync(Razor.Path());
        Assert.Equal(
            "ok",
            await sidecar.SendAndDeserializeAsync<string>(
                "workspace/open",
                MessagePackSerializer.Serialize(Razor.SolutionPath)
            )
        );

        // A component's C# answers inside the component.
        var counter = Razor.Path("BlazorApp", "Components", "Pages", "Counter.razor");
        var use = RazorFixture.Locate(counter, "Current count: @currentCount", "currentCount");
        var hover = await sidecar.SendAndDeserializeAsync<HoverResult?>(
            "textDocument/hover",
            At(counter, use)
        );
        Assert.NotNull(hover);
        Assert.Contains("currentCount", hover.Contents, StringComparison.Ordinal);
        Assert.Contains("int", hover.Contents, StringComparison.Ordinal);
        Assert.Equal((use.Line, use.Character), (hover.StartLine, hover.StartCharacter));

        // C# that uses a generated component finds it.
        var program = Razor.Path("BlazorApp", "Program.cs");
        Assert.DoesNotContain(
            await sidecar.SendAndDeserializeAsync<List<DiagnosticResult>>(
                "workspace/diagnostics",
                MessagePackSerializer.Serialize(program)
            ),
            diagnostic => diagnostic.Code == "CS0246"
        );
        var app = RazorFixture.Locate(program, "MapRazorComponents<App>", "App>");
        var definition = await sidecar.SendAndDeserializeAsync<LocationListResult>(
            "textDocument/definition",
            At(program, app)
        );
        var component = Assert.Single(definition.Locations);
        Assert.True(
            NativePaths.AreEqual(
                Razor.Path("BlazorApp", "Components", "App.razor"),
                component.FilePath
            ),
            component.FilePath
        );

        // A view's C# answers too.
        var view = Razor.Path("PagesApp", "Views", "Home", "Index.cshtml");
        var name = RazorFixture.Locate(view, "<h1>@Model.Name</h1>", "Name");
        var member = await sidecar.SendAndDeserializeAsync<HoverResult?>(
            "textDocument/hover",
            At(view, name)
        );
        Assert.NotNull(member);
        Assert.Contains("Name", member.Contents, StringComparison.Ordinal);
        Assert.Contains("string", member.Contents, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_a_generator_built_for_a_newer_roslyn_gives_way_to_the_bundled_compiler()
    {
        // Every Razor project of the copy whose generator needs a newer Roslyn: the component
        // app, the Razor class library and the Pages and MVC app.
        using var skewed = await Razor.OpenManagerAsync();
        string[][] razorFiles =
        [
            ["BlazorApp", "Components", "Pages", "Counter.razor"],
            ["Widgets", "Panel.razor"],
            ["PagesApp", "Views", "Home", "Index.cshtml"],
        ];
        foreach (var file in razorFiles)
        {
            var swapped = GeneratorPaths(skewed, Razor.Path(file));
            Assert.Equal(NewerSdkRazorFixture.GeneratorFiles, swapped.Select(NativePaths.NameOf));
            Assert.All(swapped, path => Assert.True(IsBundled(path), path));
            Assert.DoesNotContain(swapped, path => NativePaths.HasDirectory(path, "newer-sdk"));
        }

        // The repository's own copy resolves an SDK whose generator loads: it keeps it.
        using var matched = await current.OpenManagerAsync();
        var kept = GeneratorPaths(matched, current.Path(razorFiles[0]));
        Assert.Equal(NewerSdkRazorFixture.GeneratorFiles, kept.Select(NativePaths.NameOf));
        Assert.All(kept, path => Assert.False(IsBundled(path), path));
        Assert.All(kept, path => Assert.True(NativePaths.HasDirectory(path, "Sdks"), path));
    }

    [Fact]
    public async Task A_razor_compiler_that_cannot_be_read_leaves_the_project_as_loaded()
    {
        // A compiler path that is missing, or holds no assembly, is logged and the project
        // keeps the references it loaded with. [RAZOR-ARCHITECTURE-GENERATOR]
        using var manager = await Razor.OpenManagerAsync();
        var counter = Razor.Path("BlazorApp", "Components", "Pages", "Counter.razor");
        var loader = manager
            .FindRazorDocument(counter)
            ?.Project.AnalyzerReferences.OfType<AnalyzerFileReference>()
            .First()
            .AssemblyLoader;
        Assert.NotNull(loader);
        var unread = Razor.Path("unread", NewerSdkRazorFixture.Compiler);
        _ = Directory.CreateDirectory(NativePaths.DirectoryOf(unread));
        await File.WriteAllTextAsync(unread, "not an assembly");
        string[] compilers = [Razor.Path("missing", NewerSdkRazorFixture.Compiler), unread];
        foreach (var compiler in compilers)
        {
            var reference = new AnalyzerFileReference(compiler, loader);
            var project = ProjectInfo.Create(
                ProjectId.CreateNewId(),
                VersionStamp.Create(),
                "Unread",
                "Unread",
                LanguageNames.CSharp,
                analyzerReferences: [reference]
            );
            var kept = RazorGenerator.Compatible(project);
            Assert.Same(project, kept);
            Assert.Same(reference, Assert.Single(kept.AnalyzerReferences));
            Assert.Equal(compiler, kept.AnalyzerReferences[0].FullPath);
        }
    }

    private static byte[] At(string file, (int Line, int Character) position)
    {
        return MessagePackSerializer.Serialize(
            new PositionRequest
            {
                FilePath = file,
                Line = position.Line,
                Character = position.Character,
            }
        );
    }

    /// <summary>The Razor generator's files that the project listing <paramref name="razorFile"/> loads, in ordinal order.</summary>
    private static string[] GeneratorPaths(WorkspaceManager manager, string razorFile)
    {
        var project = manager.FindRazorDocument(razorFile)?.Project;
        Assert.NotNull(project);
        return
        [
            .. project
                .AnalyzerReferences.Select(reference => reference.FullPath)
                .OfType<string>()
                .Where(path =>
                    NewerSdkRazorFixture.GeneratorFiles.Any(file =>
                        NativePaths.SameName(path, file)
                    )
                )
                .OrderBy(NativePaths.NameOf, StringComparer.Ordinal),
        ];
    }

    /// <summary>Whether <paramref name="path"/> is the copy the sidecar bundles beside itself.</summary>
    private static bool IsBundled(string path)
    {
        return NativePaths.AreEqual(
            path,
            NativePaths.Join(AppContext.BaseDirectory, NativePaths.NameOf(path))
        );
    }
}
