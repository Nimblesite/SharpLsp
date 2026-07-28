using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Outcome;
using Serilog;
using VoidResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

internal sealed partial class WorkspaceManager
{
    private AdhocWorkspace? _adhocWorkspace;

    private static readonly string[] Net10ImplicitUsings =
    [
        "System",
        "System.Collections.Generic",
        "System.IO",
        "System.Linq",
        "System.Net.Http",
        "System.Threading",
        "System.Threading.Tasks",
    ];

    private async Task<VoidResult> OpenSingleFileModeAsync(string path, CancellationToken ct)
    {
        var csFiles = ResolveCsFiles(path);
        if (csFiles.Length == 0)
        {
            return VoidResult.Failure(
                $"No .sln, .slnx, .csproj, or .cs files found at '{path}'."
            );
        }

        _adhocWorkspace = new AdhocWorkspace();

        var projectInfo = ProjectInfo.Create(
            ProjectId.CreateNewId(),
            VersionStamp.Default,
            "SingleFileApp",
            "SingleFileApp",
            LanguageNames.CSharp,
            compilationOptions: new CSharpCompilationOptions(
                OutputKind.ConsoleApplication,
                usings: Net10ImplicitUsings
            ),
            parseOptions: new CSharpParseOptions(LanguageVersion.Preview),
            metadataReferences: Basic.Reference.Assemblies.Net100.References.All
        );

        var project = _adhocWorkspace.AddProject(projectInfo);

        foreach (var csFile in csFiles)
        {
            var text = await File.ReadAllTextAsync(csFile, ct).ConfigureAwait(false);
            var documentInfo = DocumentInfo.Create(
                DocumentId.CreateNewId(project.Id),
                Path.GetFileName(csFile),
                loader: TextLoader.From(TextAndVersion.Create(SourceText.From(text), VersionStamp.Create())),
                filePath: csFile
            );
            _ = _adhocWorkspace.AddDocument(documentInfo);
        }

        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _solution = _adhocWorkspace.CurrentSolution;
            ReplayPendingTextEdits();
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }

        Log.Information(
            "Loaded {FileCount} file(s) in single-file mode from {Path}",
            csFiles.Length,
            path
        );

        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    private static string[] ResolveCsFiles(string path)
    {
        return File.Exists(path) && path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
            ? [path]
            : Directory.Exists(path) ? Directory.GetFiles(path, "*.cs", SearchOption.TopDirectoryOnly) : [];
    }
}
