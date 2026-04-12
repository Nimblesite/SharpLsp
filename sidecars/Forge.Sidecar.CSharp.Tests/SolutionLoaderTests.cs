using Forge.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers
#pragma warning disable IDE0058 // Expression value is never used

namespace Forge.Sidecar.CSharp.Tests;

/// <summary>
/// Tests for <see cref="SolutionLoader"/> — proves bugs in solution discovery.
/// </summary>
public sealed class SolutionLoaderTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"forge-sln-loader-{Guid.NewGuid():N}"
    );

    public SolutionLoaderTests()
    {
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(_root, true);
        }
        catch
        {
            // best-effort cleanup
        }
    }

    [Fact]
    public void Single_sln_in_root_is_found()
    {
        File.WriteAllText(Path.Combine(_root, "App.sln"), "");
        var result = SolutionLoader.FindSolutionOrProject(_root);
        Assert.True(
            result is Outcome.Result<string?, string>.Ok<string?, string> { Value: not null }
        );
    }

    [Fact]
    public void Explicit_sln_path_returns_that_exact_file()
    {
        var slnPath = Path.Combine(_root, "Exact.sln");
        File.WriteAllText(slnPath, "");
        var result = SolutionLoader.FindSolutionOrProject(slnPath);
        var value = result.Match(v => v, _ => null);
        Assert.Equal(slnPath, value);
    }

    /// <summary>
    /// BUG: When multiple .sln files exist in subdirectories and none in root,
    /// FindRecursiveMatch returns the first one found by Directory.GetFiles
    /// which is non-deterministic. The caller has NO control over which
    /// solution gets loaded.
    ///
    /// This test proves the bug: when workspace/open receives a directory
    /// containing multiple solutions in subdirectories, the sidecar should
    /// NOT silently pick an arbitrary one. It should either:
    /// - Return an error asking the caller to specify which solution
    /// - Accept an explicit solution path instead of a directory
    /// </summary>
    [Fact]
    public void Multiple_sln_in_subdirs_should_not_pick_arbitrary_one()
    {
        // Create two .sln files in different subdirectories.
        var subA = Path.Combine(_root, "examples");
        var subB = Path.Combine(_root, "sidecars");
        Directory.CreateDirectory(subA);
        Directory.CreateDirectory(subB);
        File.WriteAllText(Path.Combine(subA, "Test.sln"), "");
        File.WriteAllText(Path.Combine(subB, "Real.sln"), "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        // BUG: Currently this returns Ok with an arbitrary .sln path.
        // It SHOULD return an error or null when ambiguous, forcing the
        // caller to provide an explicit path.
        Assert.True(
            result
                is Outcome.Result<string?, string>.Ok<string?, string> { Value: null }
                    or Outcome.Result<string?, string>.Error<string?, string>,
            "Ambiguous solution discovery must NOT silently pick an arbitrary .sln. "
                + $"Got: {result.Match(v => v ?? "null", e => $"Error: {e}")}"
        );
    }

    /// <summary>
    /// BUG: workspace/open receives a workspace root directory, but
    /// the user may have selected a specific solution. The sidecar MUST
    /// accept an explicit .sln path and load that exact solution.
    /// </summary>
    [Fact]
    public void Explicit_sln_path_loads_exact_solution_not_recursive_search()
    {
        // Create two .sln files — one the user wants, one they don't.
        var wanted = Path.Combine(_root, "sidecars", "Wanted.sln");
        var unwanted = Path.Combine(_root, "examples", "Unwanted.sln");
        Directory.CreateDirectory(Path.GetDirectoryName(wanted)!);
        Directory.CreateDirectory(Path.GetDirectoryName(unwanted)!);
        File.WriteAllText(wanted, "");
        File.WriteAllText(unwanted, "");

        // When given the EXPLICIT path, it must return that exact file.
        var result = SolutionLoader.FindSolutionOrProject(wanted);
        var value = result.Match(v => v, _ => null);
        Assert.Equal(wanted, value);
    }
}
