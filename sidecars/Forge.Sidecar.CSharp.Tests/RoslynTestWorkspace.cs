using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

#pragma warning disable CA1515 // Types can be internal
#pragma warning disable RS1035 // File/Console banned for analyzers — we're tests, not analyzers

namespace Forge.Sidecar.CSharp.Tests;

/// <summary>
/// Builds a lightweight Roslyn <see cref="AdhocWorkspace"/> for direct
/// resolver tests — avoids the MSBuild registration and long startup of
/// the full sidecar E2E fixture.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Reliability",
    "CA2000:Dispose objects before losing scope",
    Justification = "Workspace is kept alive for the duration of the test"
)]
internal static class RoslynTestWorkspace
{
    public static (Document document, Solution solution) Create(string source)
    {
        var workspace = new AdhocWorkspace();
        var project = workspace.AddProject(
            ProjectInfo
                .Create(
                    ProjectId.CreateNewId(),
                    VersionStamp.Default,
                    "TestProject",
                    "TestProject",
                    LanguageNames.CSharp
                )
                .WithCompilationOptions(
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                )
                .WithMetadataReferences(ReferenceAssemblies())
        );
        var document = workspace.AddDocument(project.Id, "Test.cs", SourceText(source));
        return (document, workspace.CurrentSolution);
    }

    private static Microsoft.CodeAnalysis.Text.SourceText SourceText(string source)
    {
        return Microsoft.CodeAnalysis.Text.SourceText.From(source);
    }

    private static List<MetadataReference> ReferenceAssemblies()
    {
        var refs = new List<MetadataReference>
        {
            MetadataReference.CreateFromFile(typeof(object).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Console).Assembly.Location),
            MetadataReference.CreateFromFile(typeof(Enumerable).Assembly.Location),
        };

        // Add runtime assemblies so System.Runtime types resolve cleanly.
        var runtimeDir =
            Path.GetDirectoryName(typeof(object).Assembly.Location)
            ?? throw new InvalidOperationException("Runtime directory not found");
        foreach (
            var name in new[] { "System.Runtime.dll", "netstandard.dll", "System.Collections.dll" }
        )
        {
            var path = Path.Combine(runtimeDir, name);
            if (File.Exists(path))
            {
                refs.Add(MetadataReference.CreateFromFile(path));
            }
        }

        return refs;
    }
}
