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
/// tests can edit it, and built so the F# DLL that BlazorApp references exists.
/// </summary>
public sealed class RazorFixture : IDisposable
{
    private readonly string _root = NativePaths.Temp($"sharplsp-razor-{Guid.NewGuid():N}");

    public RazorFixture()
    {
        CopyTree(FindRepositoryFixture(), _root);
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

    private static string FindRepositoryFixture()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = NativePaths.Join(
                directory.FullName,
                "src",
                "sharplsp",
                "tests",
                "fixtures",
                "razor"
            );
            if (File.Exists(NativePaths.Join(candidate, "RazorFixtures.slnx")))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("The Razor fixture solution was not found");
    }
}
