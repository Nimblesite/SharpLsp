#pragma warning disable RS1035 // File IO banned for analyzers - tests own temp fixtures
using SharpLsp.Sidecar.Common.Solutions;

#pragma warning disable CA1515 // Types can be internal

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// [ANALYZERS-TRUTH] across languages: which projects the OTHER language references,
/// read from real solution, project and folder targets on disk, and re-read as the
/// referencing project file is edited (#617).
/// </summary>
public sealed class CrossLanguageReferencesTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"sharplsp-crosslang-{Guid.NewGuid():N}");
    private readonly string _fsLib;
    private readonly string _csLib;
    private readonly string _csApp;

    public CrossLanguageReferencesTests()
    {
        _ = Directory.CreateDirectory(_root);
        _fsLib = Project("FsLib", "FsLib.fsproj");
        _csLib = Project("CsLib", "CsLib.csproj");
        _csApp = Project("CsApp", "CsApp.csproj");
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
    public async Task A_reference_from_the_other_language_is_followed_as_the_project_file_is_edited()
    {
        var solution = Solution(
            "<Project Path=\"FsLib/FsLib.fsproj\" />",
            "<Project Path=\"CsLib/CsLib.csproj\" />",
            "<Project Path=\"CsApp/CsApp.csproj\" />"
        );
        var references = await CrossLanguageReferences.OfAsync(solution, CancellationToken.None);

        // 1. Nothing references anything: no project is shared.
        Assert.False(references.Contains(_fsLib), "an unreferenced F# library is no one's");
        Assert.False(references.Contains(_csLib), "an unreferenced C# library is no one's");

        // 2. The C# app references BOTH libraries: only the F# one crosses a language.
        Rewrite(_csApp, "../FsLib/FsLib.fsproj", "../CsLib/CsLib.csproj");
        Assert.True(references.Contains(_fsLib), "C# now calls into the F# library");
        Assert.False(references.Contains(_csLib), "C# calling C# is Roslyn's own to judge");
        Assert.False(references.Contains(_csApp), "nothing references the app");

        // 3. The reference is removed again: the F# library is its compiler's alone.
        Rewrite(_csApp, "../CsLib/CsLib.csproj");
        Assert.False(references.Contains(_fsLib), "the removed reference is forgotten");
        Assert.False(references.Contains(_csLib), "and the same-language one never counted");
    }

    [Fact]
    public async Task Folders_and_project_files_are_targets_and_nothing_else_is()
    {
        Rewrite(_csApp, "../FsLib/FsLib.fsproj");
        var folder = await CrossLanguageReferences.OfAsync(_root, CancellationToken.None);
        Assert.True(folder.Contains(_fsLib), "a folder holds every project beneath it");
        Assert.False(folder.Contains(_csApp), "and the app is referenced by none");

        var file = await CrossLanguageReferences.OfAsync(_csApp, CancellationToken.None);
        Assert.True(file.Contains(_fsLib), "a project file is its own workspace");

        var missing = NativePaths.Resolve(_root, "Gone.csproj");
        Assert.False(
            (await CrossLanguageReferences.OfAsync(missing, CancellationToken.None)).Contains(
                _fsLib
            ),
            "a missing target has no projects"
        );
        Assert.False(
            CrossLanguageReferences.None.Contains(_fsLib),
            "no workspace references nothing"
        );
    }

    [Fact]
    public async Task A_solution_that_cannot_be_read_has_no_projects()
    {
        Rewrite(_csApp, "../FsLib/FsLib.fsproj");
        var broken = NativePaths.Resolve(_root, "Broken.slnx");
        await File.WriteAllTextAsync(broken, "<Solution><Project Path=", CancellationToken.None);

        var references = await CrossLanguageReferences.OfAsync(broken, CancellationToken.None);

        Assert.False(references.Contains(_fsLib), "an unreadable solution shares nothing");
        Assert.False(references.Contains(_csApp), "nor anything else");
    }

    private string Project(string folder, string file)
    {
        var dir = NativePaths.Resolve(_root, folder);
        _ = Directory.CreateDirectory(dir);
        var path = NativePaths.Resolve(dir, file);
        File.WriteAllText(path, "<Project Sdk=\"Microsoft.NET.Sdk\" />");
        return path;
    }

    private string Solution(params string[] projects)
    {
        var path = NativePaths.Resolve(_root, "Mixed.slnx");
        File.WriteAllText(path, $"<Solution>{string.Concat(projects)}</Solution>");
        return path;
    }

    /// <summary>Rewrite <paramref name="project"/> to reference <paramref name="includes"/>, as a later edit.</summary>
    private static void Rewrite(string project, params string[] includes)
    {
        var items = string.Concat(
            includes.Select(include => $"<ProjectReference Include=\"{include}\" />")
        );
        var previous = File.GetLastWriteTimeUtc(project);
        File.WriteAllText(
            project,
            $"<Project Sdk=\"Microsoft.NET.Sdk\"><ItemGroup>{items}</ItemGroup></Project>"
        );
        // A coarse filesystem clock must still see an edit.
        File.SetLastWriteTimeUtc(project, previous.AddSeconds(2));
    }
}
