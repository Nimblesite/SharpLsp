using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;
using SharpLsp.Sidecar.CSharp.Razor;

#pragma warning disable CA1515 // Public xUnit discovery type
#pragma warning disable CA2007 // xUnit executes without a synchronization context

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// A location outside the workspace's documents, such as decompiled source, is looked up as
/// a Razor projection only in projects that list a Razor file, so navigating from a solution
/// without Razor never compiles a project to run its generators. Implements [RAZOR-TESTING]
/// for [RAZOR-ARCHITECTURE-PROJECTION].
/// </summary>
public sealed class RazorLocationsTests
{
    [Fact]
    public async Task A_solution_without_razor_files_compiles_nothing_to_find_a_projection()
    {
        using var workspace = new AdhocWorkspace();
        // Every SDK project carries source generators, and running them means compiling.
        var solution = workspace
            .CurrentSolution.AddProject("Plain", "Plain", LanguageNames.CSharp)
            .AddAnalyzerReference(new GeneratorReference(new FixedSources([])))
            .AddDocument("Program.cs", SourceText.From("class Program { }"))
            .Project.Solution;

        var projection = await RazorLocations.FindProjectionAsync(
            solution,
            NativePaths.Temp("Console.cs"),
            default
        );

        Assert.Null(projection);
        var project = Assert.Single(solution.Projects);
        Assert.False(
            project.TryGetCompilation(out _),
            "no project compiles just to look for a Razor projection"
        );
    }
}
