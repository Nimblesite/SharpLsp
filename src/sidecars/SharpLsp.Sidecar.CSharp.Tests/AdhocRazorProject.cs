using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;
using SharpLsp.Sidecar.Common;

namespace SharpLsp.Sidecar.CSharp.Tests;

/// <summary>
/// An in-memory C# project for Razor unit tests, shaped the way MSBuild hands a project to the
/// sidecar: Razor files as additional documents, MSBuild properties and file metadata in a
/// global analyzer config, and generated sources standing in for the SDK's Razor generator.
/// Implements [RAZOR-TESTING].
/// </summary>
internal static class AdhocRazorProject
{
    /// <summary>The project's directory.</summary>
    public static string Directory { get; } = NativePaths.Temp("AdhocRazor");

    /// <summary>A path inside the project's directory.</summary>
    public static string PathOf(params string[] segments)
    {
        return NativePaths.Resolve(Directory, segments);
    }

    /// <summary>
    /// The project <c>App</c>: <paramref name="files"/> are its additional documents,
    /// <paramref name="globalConfig"/> its MSBuild analyzer options, and
    /// <paramref name="generated"/> what its generator adds.
    /// </summary>
    public static Project Create(
        AdhocWorkspace workspace,
        IEnumerable<(string Path, string Text)> files,
        string globalConfig = "",
        IReadOnlyList<(string Hint, string Source)>? generated = null
    )
    {
        var id = ProjectId.CreateNewId();
        var solution = workspace
            .CurrentSolution.AddProject(Info(id, generated ?? []))
            .AddAnalyzerConfigDocument(
                DocumentId.CreateNewId(id),
                ".globalconfig",
                SourceText.From("is_global = true\n" + globalConfig),
                filePath: PathOf(".globalconfig")
            );
        return files
            .Aggregate(solution, (current, file) => WithFile(current, id, file))
            .GetProject(id)!;
    }

    /// <summary>The additional document at <paramref name="path"/>.</summary>
    public static TextDocument Additional(Project project, string path)
    {
        return project.AdditionalDocuments.Single(document =>
            NativePaths.AreEqual(document.FilePath, path)
        );
    }

    private static ProjectInfo Info(
        ProjectId id,
        IReadOnlyList<(string Hint, string Source)> generated
    )
    {
        return ProjectInfo.Create(
            id,
            VersionStamp.Default,
            "App",
            "App",
            LanguageNames.CSharp,
            filePath: PathOf("App.csproj"),
            analyzerReferences: [new GeneratorReference(new FixedSources(generated))]
        );
    }

    private static Solution WithFile(
        Solution solution,
        ProjectId id,
        (string Path, string Text) file
    )
    {
        return solution.AddAdditionalDocument(
            DocumentId.CreateNewId(id),
            NativePaths.NameOf(file.Path),
            SourceText.From(file.Text),
            filePath: file.Path
        );
    }
}

/// <summary>An analyzer reference that supplies <paramref name="generators"/>.</summary>
internal sealed class GeneratorReference(params IIncrementalGenerator[] generators)
    : AnalyzerReference
{
    private readonly ImmutableArray<ISourceGenerator> _generators =
    [
        .. generators.Select(GeneratorExtensions.AsSourceGenerator),
    ];

    /// <inheritdoc />
    public override string FullPath => "";

    /// <inheritdoc />
    public override object Id { get; } = Guid.NewGuid();

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticAnalyzer> GetAnalyzers(string language)
    {
        return [];
    }

    /// <inheritdoc />
    public override ImmutableArray<DiagnosticAnalyzer> GetAnalyzersForAllLanguages()
    {
        return [];
    }

    /// <inheritdoc />
    public override ImmutableArray<ISourceGenerator> GetGenerators(string language)
    {
        return _generators;
    }
}

/// <summary>
/// A generator that adds the same sources every run, as the SDK's Razor generator adds one
/// projection per Razor file. With no sources it stands for a project's other generators,
/// which add nothing but still make Roslyn compile the project to run them.
/// </summary>
internal sealed class FixedSources(IReadOnlyList<(string Hint, string Source)> sources)
    : IIncrementalGenerator
{
    /// <inheritdoc />
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        context.RegisterPostInitializationOutput(output =>
        {
            foreach (var (hint, source) in sources)
            {
                output.AddSource(hint, source);
            }
        });
    }
}
