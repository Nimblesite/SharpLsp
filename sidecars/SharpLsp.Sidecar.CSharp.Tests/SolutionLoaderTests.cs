using SharpLsp.Sidecar.CSharp.Workspace;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // Path.GetTempPath banned for analyzers
#pragma warning disable IDE0058 // Expression value is never used

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// Tests for <see cref="SolutionLoader"/> — proves bugs in solution discovery.
/// </summary>
public sealed class SolutionLoaderTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"sharplsp-sln-loader-{Guid.NewGuid():N}"
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

    [Fact]
    public void Csproj_in_root_is_found_when_no_sln_present()
    {
        var csproj = Path.Combine(_root, "App.csproj");
        File.WriteAllText(csproj, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(csproj, value);
    }

    [Fact]
    public void Nonexistent_path_returns_null()
    {
        var missing = Path.Combine(_root, "does_not_exist");

        var result = SolutionLoader.FindSolutionOrProject(missing);

        var value = result.Match(v => v, _ => "ERR");
        Assert.Null(value);
    }

    [Fact]
    public void Multiple_sln_in_root_picks_one_matching_dir_name()
    {
        // Workspace dir "MyApp" with "Other.sln" and "MyApp.sln" — must pick MyApp.sln.
        var app = Path.Combine(_root, "MyApp");
        Directory.CreateDirectory(app);
        var wanted = Path.Combine(app, "MyApp.sln");
        var other = Path.Combine(app, "Other.sln");
        File.WriteAllText(wanted, "");
        File.WriteAllText(other, "");

        var result = SolutionLoader.FindSolutionOrProject(app);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(wanted, value);
    }

    [Fact]
    public void Multiple_sln_in_root_without_matching_name_falls_back_to_first()
    {
        // Two unrelated .sln files in root — pick the first one returned by OS.
        var a = Path.Combine(_root, "A.sln");
        var b = Path.Combine(_root, "B.sln");
        File.WriteAllText(a, "");
        File.WriteAllText(b, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.True(value == a || value == b);
    }

    [Fact]
    public void Single_csproj_in_subdir_is_found_recursively()
    {
        // No .sln, one .csproj nested — recursive search should find it.
        var sub = Path.Combine(_root, "nested", "Project");
        Directory.CreateDirectory(sub);
        var csproj = Path.Combine(sub, "Deep.csproj");
        File.WriteAllText(csproj, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(csproj, value);
    }

    [Fact]
    public void Single_sln_in_subdir_is_found_recursively()
    {
        var sub = Path.Combine(_root, "nested", "Solution");
        Directory.CreateDirectory(sub);
        var sln = Path.Combine(sub, "Nested.sln");
        File.WriteAllText(sln, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(sln, value);
    }

    [Fact]
    public void Single_slnx_in_root_is_found()
    {
        var slnx = Path.Combine(_root, "App.slnx");
        File.WriteAllText(slnx, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(slnx, value);
    }

    [Fact]
    public void Single_slnx_in_subdir_is_found_recursively()
    {
        // Mirrors the user-reported case: TradiSite/backend/AiCms.slnx where
        // the workspace root is one level above the .slnx.
        var sub = Path.Combine(_root, "backend");
        Directory.CreateDirectory(sub);
        var slnx = Path.Combine(sub, "AiCms.slnx");
        File.WriteAllText(slnx, "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(slnx, value);
    }

    [Fact]
    public void Explicit_slnx_path_returns_that_exact_file()
    {
        var slnx = Path.Combine(_root, "Exact.slnx");
        File.WriteAllText(slnx, "");

        var result = SolutionLoader.FindSolutionOrProject(slnx);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(slnx, value);
    }

    [Fact]
    public void Slnx_in_root_takes_priority_over_recursive_csproj()
    {
        var slnx = Path.Combine(_root, "App.slnx");
        File.WriteAllText(slnx, "");
        var sub = Path.Combine(_root, "nested");
        Directory.CreateDirectory(sub);
        File.WriteAllText(Path.Combine(sub, "Other.csproj"), "");

        var result = SolutionLoader.FindSolutionOrProject(_root);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(slnx, value);
    }

    [Fact]
    public void Slnx_in_root_is_picked_with_matching_name_alongside_sln()
    {
        // Coexisting .sln and .slnx — name-based tiebreak still applies.
        var app = Path.Combine(_root, "MyApp");
        Directory.CreateDirectory(app);
        var wanted = Path.Combine(app, "MyApp.slnx");
        var other = Path.Combine(app, "Other.sln");
        File.WriteAllText(wanted, "");
        File.WriteAllText(other, "");

        var result = SolutionLoader.FindSolutionOrProject(app);

        var value = result.Match(v => v, _ => null);
        Assert.Equal(wanted, value);
    }
}
