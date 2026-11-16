using System.Diagnostics;

#pragma warning disable CA1515 // xunit test classes must be public
#pragma warning disable RS1035 // File IO is banned for analyzers — these are tests
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.Common.Tests;

/// <summary>
/// [DIAG-CONFIG-OWNED-SOURCES] Workspace discovery leaves out what git ignores, asked of a
/// real git repository: an ignored folder, an ignored pattern and a nested clone. A folder
/// opened on purpose keeps its projects, and so does a folder outside any repository.
/// </summary>
public sealed class GitIgnoreTests : IDisposable
{
    private readonly string _root = NativePaths.Temp($"sharplsp-gitignore-{Guid.NewGuid():N}");

    public GitIgnoreTests()
    {
        foreach (
            var project in new[]
            {
                "A.fsproj",
                "src/B.fsproj",
                "src/E.generated.fsproj",
                "scratch/C.fsproj",
                "scratch/deep/D.fsproj",
                "vendor/Lib/Lib.fsproj",
                "vendor/Tool/Tool.csproj",
            }
        )
        {
            Write(project, "<Project />");
        }
        Write(".gitignore", "scratch/\nvendor/\n*.generated.fsproj\n");
        Git(_root, "init", "-q");
        // The vendored library is its own clone, as a gitignored checkout is.
        Git(NativePaths.Join(_root, "vendor", "Lib"), "init", "-q");
    }

    public void Dispose()
    {
        // Git marks its object files read-only, which blocks deletion on Windows.
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }
        Directory.Delete(_root, true);
    }

    private void Write(string relative, string text)
    {
        var path = NativePaths.Resolve(_root, relative);
        Directory.CreateDirectory(NativePaths.DirectoryOf(path));
        File.WriteAllText(path, text);
    }

    private static void Git(string directory, params string[] arguments)
    {
        var info = new ProcessStartInfo("git")
        {
            WorkingDirectory = directory,
            UseShellExecute = false,
        };
        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }
        using var git = Process.Start(info);
        Assert.NotNull(git);
        git.WaitForExit();
        Assert.Equal(0, git.ExitCode);
    }

    private string[] Projects(params string[] relative)
    {
        return
        [
            .. relative
                .Select(path => NativePaths.Resolve(_root, path))
                .Order(NativePaths.Comparer),
        ];
    }

    private static string[] Found(string root)
    {
        return
        [
            .. NativePaths
                .WorkspaceFiles(root, ".fsproj")
                .Select(NativePaths.NormalizeFullPath)
                .Order(NativePaths.Comparer),
        ];
    }

    [Fact]
    public void Discovery_leaves_out_ignored_folders_patterns_and_nested_clones()
    {
        // Interaction 1 — from the repository root only the developer's own projects remain:
        // not the ignored folder at any depth, the ignored pattern, or the nested clone.
        Assert.Equal(Projects("A.fsproj", "src/B.fsproj"), Found(_root));

        // Every C# project of the repository is ignored: none is found, because the
        // root itself is not an ignored folder opened on purpose.
        Assert.Empty(NativePaths.WorkspaceFiles(_root, ".csproj"));

        // Interaction 2 — a subfolder with nothing ignored is unaffected by the question.
        Assert.Equal(Projects("src/B.fsproj"), Found(NativePaths.Resolve(_root, "src")));

        // Interaction 3 — an ignored folder opened on purpose keeps every project in it.
        Assert.Equal(
            Projects("scratch/C.fsproj", "scratch/deep/D.fsproj"),
            Found(NativePaths.Resolve(_root, "scratch"))
        );

        // Interaction 4 — the nested clone is its own repository, where nothing is ignored.
        Assert.Equal(
            Projects("vendor/Lib/Lib.fsproj"),
            Found(NativePaths.Resolve(_root, "vendor", "Lib"))
        );

        // Interaction 5 — un-ignoring a path brings its project back on the next walk.
        Write(".gitignore", "vendor/\n");
        Assert.Equal(
            Projects(
                "A.fsproj",
                "src/B.fsproj",
                "src/E.generated.fsproj",
                "scratch/C.fsproj",
                "scratch/deep/D.fsproj"
            ),
            Found(_root)
        );
    }

    [Fact]
    public void Kept_answers_without_git_and_for_nothing()
    {
        // Outside any repository git refuses to answer: nothing is ignored.
        var outside = NativePaths.Temp($"sharplsp-nogit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(outside);
        try
        {
            var file = NativePaths.Join(outside, "Only.fsproj");
            File.WriteAllText(file, "<Project />");
            Assert.Equal([file], GitIgnore.Kept(outside, [file]));
            Assert.Empty(GitIgnore.Kept(outside, []));
            // A folder that does not exist cannot start git at all: still nothing ignored.
            var missing = NativePaths.Join(outside, "missing");
            Assert.Equal([file], GitIgnore.Kept(missing, [file]));
        }
        finally
        {
            Directory.Delete(outside, true);
        }
    }

    [Theory]
    [InlineData("src/obj/Debug/App.AssemblyInfo.fs", true)]
    [InlineData("src/bin/Release/Generated.cs", true)]
    [InlineData("src/objects/Model.fs", false)]
    [InlineData("src/binary/Reader.cs", false)]
    [InlineData("src/App/Program.fs", false)]
    public void Build_output_is_a_directory_named_obj_or_bin(string relative, bool expected)
    {
        Assert.Equal(expected, NativePaths.IsBuildOutput(NativePaths.Resolve(_root, relative)));
    }
}
