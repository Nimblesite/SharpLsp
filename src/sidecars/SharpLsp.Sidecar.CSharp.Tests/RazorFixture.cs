using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Public xUnit fixture type
#pragma warning disable RS1035 // Real-process/temp-path use is intentional: the fixture is built for real
#pragma warning disable CA2007 // xUnit executes without a synchronization context
#pragma warning disable IDE0058 // Directory.CreateDirectory's result is not needed

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A built copy of the Razor fixture solution ([RAZOR-TESTING]): BlazorApp, the Widgets
/// Razor class library, PagesApp and the F# Domain library. Copied to a temp directory so
/// tests can edit it, and built so the F# DLL that BlazorApp references exists. The copy
/// keeps the SDK the repository pins: with no <c>global.json</c> above it, it would load with
/// the newest installed SDK, as the editor suites' copies would.
/// </summary>
public sealed class RazorFixture : IDisposable
{
    /// <summary>The fixture solution's directory, relative to the repository root.</summary>
    private static readonly string[] FixtureDirectory =
    [
        "src",
        "sharplsp",
        "tests",
        "fixtures",
        "razor",
    ];

    private readonly string _root = NativePaths.Temp($"sharplsp-razor-{Guid.NewGuid():N}");

    public RazorFixture()
        : this(_ => { }) { }

    /// <summary>The fixture, built once <paramref name="prepare"/> has changed the copy at its root.</summary>
    internal RazorFixture(Action<string> prepare)
    {
        var repository = FindRepository();
        CopyTree(NativePaths.Join([repository, .. FixtureDirectory]), _root);
        File.Copy(NativePaths.Join(repository, "global.json"), Path("global.json"));
        prepare(_root);
        SolutionPath = Path("RazorFixtures.slnx");
        var (exitCode, output) = DotnetBuild.Run(SolutionPath);
        Assert.True(exitCode == 0, $"Razor fixture build failed ({exitCode}):{output}");
    }

    /// <summary>The fixture's solution file.</summary>
    public string SolutionPath { get; }

    /// <summary>A fixture file by its path relative to the solution directory.</summary>
    public string Path(params string[] relative)
    {
        return NativePaths.Join([_root, .. relative]);
    }

    /// <summary>A workspace manager with the fixture solution loaded.</summary>
    internal async Task<WorkspaceManager> OpenManagerAsync()
    {
        var manager = new WorkspaceManager();
#pragma warning disable CS0618 // OpenAsync remains the real workspace-loading boundary
        var open = await manager.OpenAsync(SolutionPath);
#pragma warning restore CS0618
        Assert.False(open.IsError, open.Match(_ => "ok", error => error));
        return manager;
    }

    /// <summary>
    /// The position of <paramref name="token"/> on the first line of <paramref name="file"/>
    /// holding <paramref name="anchor"/>, plus <paramref name="offset"/> characters.
    /// </summary>
    public static (int Line, int Character) Locate(
        string file,
        string anchor,
        string token,
        int offset = 0
    )
    {
        var lines = File.ReadAllLines(file);
        var line = Array.FindIndex(lines, text => text.Contains(anchor, StringComparison.Ordinal));
        Assert.True(line >= 0, $"missing line anchor {anchor}");
        var character = lines[line].IndexOf(token, StringComparison.Ordinal);
        Assert.True(character >= 0, $"missing token {token}");
        return (line, character + offset);
    }

    /// <summary>The value of a successful result; a failure fails the test with its message.</summary>
    public static T Ok<T>(Outcome.Result<T, string> result)
    {
        return result.Match(value => value, error => throw new Xunit.Sdk.XunitException(error));
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch (IOException) { }
    }

    private static void CopyTree(string source, string destination)
    {
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var relative = NativePaths.RelativeTo(source, file);
            if (
                NativePaths.HasDirectory(relative, "bin")
                || NativePaths.HasDirectory(relative, "obj")
            )
            {
                continue;
            }

            var target = NativePaths.Join(destination, relative);
            Directory.CreateDirectory(NativePaths.DirectoryOf(target));
            File.Copy(file, target);
        }
    }

    /// <summary>The repository root: the nearest ancestor holding the fixture solution.</summary>
    private static string FindRepository()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (
                File.Exists(
                    NativePaths.Join([
                        directory.FullName,
                        .. FixtureDirectory,
                        "RazorFixtures.slnx",
                    ])
                )
            )
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("The Razor fixture solution was not found");
    }
}
