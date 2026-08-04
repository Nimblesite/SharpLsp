using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Outcome;
using Serilog;
using VoidResult = Outcome.Result<Outcome.Unit, string>;

namespace SharpLsp.Sidecar.CSharp.Workspace;

/// <summary>Which project-less compilation model a document uses.</summary>
internal enum ProjectlessKind
{
    Unsupported,
    FileBasedApp,
    Script,
}

/// <summary>
/// Loads project-less C# documents: .NET file-based apps (<c>.cs</c> with <c>#:</c> directives)
/// and Roslyn scripts (<c>.csx</c>). Implements [SCRIPT-FILEBASED], [SCRIPT-CSX].
/// </summary>
internal sealed partial class WorkspaceManager
{
    private AdhocWorkspace? _adhocWorkspace;

    // Script default imports, matching Roslyn's scripting host. Implements [SCRIPT-CSX-OPTIONS].
    private static readonly string[] ScriptImports =
    [
        "System",
        "System.IO",
        "System.Collections.Generic",
        "System.Console",
        "System.Diagnostics",
        "System.Dynamic",
        "System.Linq",
        "System.Linq.Expressions",
        "System.Text",
        "System.Threading.Tasks",
    ];

    // Implicit usings the .NET SDK applies to a console file-based app.
    private static readonly string[] ConsoleImplicitUsings =
    [
        "System",
        "System.Collections.Generic",
        "System.IO",
        "System.Linq",
        "System.Net.Http",
        "System.Threading",
        "System.Threading.Tasks",
    ];

    /// <summary>Classify a path into its project-less compilation model. [SCRIPT-DETECT]</summary>
    internal static ProjectlessKind Classify(string path)
    {
        var extension = Path.GetExtension(path);
        return string.Equals(extension, ".cs", StringComparison.OrdinalIgnoreCase)
                ? ProjectlessKind.FileBasedApp
            : string.Equals(extension, ".csx", StringComparison.OrdinalIgnoreCase)
                ? ProjectlessKind.Script
            : ProjectlessKind.Unsupported;
    }

    /// <summary>
    /// Open a project-less document. The closure is derived from the ROOT FILE, never from its
    /// directory — see [SCRIPT-ANTIPATTERN]. Implements [SCRIPT-CLOSURE].
    /// </summary>
    private async Task<VoidResult> OpenProjectlessAsync(string path, CancellationToken ct)
    {
        if (!File.Exists(path))
        {
            return VoidResult.Failure(
                $"No .sln, .slnx, or .csproj found at or under '{path}', and it is not a "
                    + "file-based app or script that could be loaded on its own."
            );
        }

        var kind = Classify(path);
        if (kind == ProjectlessKind.Unsupported)
        {
            return VoidResult.Failure($"'{path}' is not a supported C# document.");
        }

        var closure = await ExpandAsync(kind, path, ct).ConfigureAwait(false);
        return closure.Files.Count == 0
            ? VoidResult.Failure($"Could not read '{path}'.")
            : await LoadClosureAsync(kind, path, closure, ct).ConfigureAwait(false);
    }

    private static Task<Closure> ExpandAsync(
        ProjectlessKind kind,
        string path,
        CancellationToken ct
    )
    {
        return kind == ProjectlessKind.Script
            ? DocumentClosure.ExpandScriptAsync(path, rootText: null, ct)
            : DocumentClosure.ExpandFileBasedAsync(path, rootText: null, ct);
    }

    private async Task<VoidResult> LoadClosureAsync(
        ProjectlessKind kind,
        string rootPath,
        Closure closure,
        CancellationToken ct
    )
    {
        _adhocWorkspace ??= new AdhocWorkspace();

        var packageReferences = await ResolvePackagesAsync(closure.Packages, ct).ConfigureAwait(false);
        var project = _adhocWorkspace.AddProject(BuildProjectInfo(kind, rootPath, packageReferences));
        DocumentId? rootDocumentId = null;
        foreach (var file in closure.Files)
        {
            var docInfo = BuildDocumentInfo(project.Id, file, kind);
            if (file.IsRoot)
            {
                rootDocumentId = docInfo.Id;
            }
            _ = _adhocWorkspace.AddDocument(docInfo);
        }

        if (rootDocumentId != null)
        {
            _documentPackages[rootDocumentId] = closure.Packages;
        }

        if (kind == ProjectlessKind.FileBasedApp)
        {
            _ = _adhocWorkspace.AddDocument(BuildGlobalUsingsInfo(project.Id, rootPath));
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

        LogClosure(kind, rootPath, closure);
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    internal async Task<VoidResult> UpdateProjectlessClosureAsync(Document document, string newText, CancellationToken ct)
    {
        if (_solution is null)
        {
            return VoidResult.Failure("No active solution.");
        }

        var kind = Classify(document.FilePath!);
        var closure = kind == ProjectlessKind.Script
            ? await DocumentClosure.ExpandScriptAsync(document.FilePath!, newText, ct).ConfigureAwait(false)
            : await DocumentClosure.ExpandFileBasedAsync(document.FilePath!, newText, ct).ConfigureAwait(false);

        var currentProject = _solution.GetProject(document.Project.Id);
        if (currentProject == null)
        {
            return VoidResult.Failure("Project not found.");
        }

        var currentDocIds = currentProject.Documents.ToDictionary(d => d.FilePath!, d => d.Id);
        var closurePaths = closure.Files.Select(f => f.Path).ToHashSet();

        var nextSolution = _solution;

        // Add new documents
        foreach (var file in closure.Files)
        {
            if (!currentDocIds.ContainsKey(file.Path))
            {
                var docInfo = BuildDocumentInfo(currentProject.Id, file, kind);
                nextSolution = nextSolution.AddDocument(docInfo);
            }
        }

        // Remove orphaned documents (except the root document)
        foreach (var (path, docId) in currentDocIds)
        {
            if (path.EndsWith(GlobalUsingsFileName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!closurePaths.Contains(path) && path != document.FilePath)
            {
                nextSolution = nextSolution.RemoveDocument(docId);
            }
        }

        // Handle package references
        if (_documentPackages.TryGetValue(document.Id, out var oldPackages) && !closure.Packages.SequenceEqual(oldPackages))
        {
            var newReferences = await ResolvePackagesAsync(closure.Packages, ct).ConfigureAwait(false);
            var updatedProject = nextSolution.GetProject(currentProject.Id)!.WithMetadataReferences(
                Basic.Reference.Assemblies.Net100.References.All.Concat(newReferences)
            );
            nextSolution = updatedProject.Solution;
            _documentPackages[document.Id] = closure.Packages;
        }

        _solution = nextSolution;
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    private static async Task<IEnumerable<PortableExecutableReference>> ResolvePackagesAsync(
        IReadOnlyList<PackageRef> packages,
        CancellationToken ct
    )
    {
        if (packages.Count == 0)
        {
            return [];
        }

        var tempDir = Path.Combine(Path.GetTempPath(), "SharpLsp_Packages_" + Guid.NewGuid().ToString("N"));
        _ = Directory.CreateDirectory(tempDir);
        try
        {
            var projPath = Path.Combine(tempDir, "restore.csproj");
            var packageItems = string.Join("\n", packages.Select(p => $"<PackageReference Include=\"{p.Name}\" Version=\"{p.Version}\" />"));
            var xml = $@"<Project Sdk=""Microsoft.NET.Sdk"">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    {packageItems}
  </ItemGroup>
</Project>";
            await File.WriteAllTextAsync(projPath, xml, ct).ConfigureAwait(false);

            var psi = new System.Diagnostics.ProcessStartInfo("dotnet", "restore --verbosity quiet")
            {
                WorkingDirectory = tempDir,
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            using var process = System.Diagnostics.Process.Start(psi);
            if (process != null)
            {
                await process.WaitForExitAsync(ct).ConfigureAwait(false);
            }

            using var workspace = Microsoft.CodeAnalysis.MSBuild.MSBuildWorkspace.Create(new Dictionary<string, string>
            {
                ["DesignTimeBuild"] = "true",
                ["BuildingInsideVisualStudio"] = "true",
                ["SkipCompilerExecution"] = "true",
            });
            var project = await workspace.OpenProjectAsync(projPath, cancellationToken: ct).ConfigureAwait(false);
            return project.MetadataReferences.OfType<PortableExecutableReference>();
        }
        finally
        {
            try { Directory.Delete(tempDir, true); } catch { }
        }
    }

    private static ProjectInfo BuildProjectInfo(ProjectlessKind kind, string rootPath, IEnumerable<PortableExecutableReference> extraReferences)
    {
        var name = Path.GetFileNameWithoutExtension(rootPath);
        var isScript = kind == ProjectlessKind.Script;
        return ProjectInfo.Create(
            ProjectId.CreateNewId(),
            VersionStamp.Create(),
            name,
            name,
            LanguageNames.CSharp,
            filePath: rootPath,
            compilationOptions: BuildCompilationOptions(isScript, rootPath),
            parseOptions: BuildParseOptions(isScript),
            // Tier 2 reference resolution: in-memory BCL only. `#:package` symbols bind
            // via MSBuildWorkspace synthetic evaluation fallback. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            metadataReferences: Basic.Reference.Assemblies.Net100.References.All.Concat(extraReferences)
        );
    }

    // Scripts need a SourceReferenceResolver rooted at the script's directory, otherwise Roslyn
    // reports CS8099 "Source file references are not supported" for every #load.
    // Implements [SCRIPT-CSX-RESOLVERS].
    private static CSharpCompilationOptions BuildCompilationOptions(bool isScript, string rootPath)
    {
        var options = new CSharpCompilationOptions(
            isScript ? OutputKind.DynamicallyLinkedLibrary : OutputKind.ConsoleApplication,
            usings: isScript ? ScriptImports : ConsoleImplicitUsings,
            nullableContextOptions: NullableContextOptions.Enable
        );
        if (!isScript)
        {
            return options;
        }

        var baseDirectory = Path.GetDirectoryName(rootPath);
        return options.WithSourceReferenceResolver(new SourceFileResolver([], baseDirectory));
    }

    // LanguageVersion.Latest, not Preview: Preview enables unstable features the user's SDK may
    // reject, producing editor-only false negatives. Implements [SCRIPT-FILEBASED-PARSEOPTIONS].
    //
    // The FileBasedProgram feature flag is what unlocks `#!` and `#:` in a Regular compilation —
    // without it Roslyn reports CS9314/CS9313. The .NET SDK passes the same flag to csc when it
    // builds a file-based app. Implements [SCRIPT-FILEBASED-SHEBANG], [SCRIPT-FILEBASED-DIRECTIVES].
    private static CSharpParseOptions BuildParseOptions(bool isScript)
    {
        var options = new CSharpParseOptions(
            LanguageVersion.Latest,
            kind: isScript ? SourceCodeKind.Script : SourceCodeKind.Regular
        );
        return isScript
            ? options
            : options.WithFeatures([new KeyValuePair<string, string>("FileBasedProgram", "true")]);
    }

    // CSharpCompilationOptions.Usings is honored only for SourceCodeKind.Script. A regular
    // compilation gets its implicit usings from a generated source file, exactly as the SDK
    // emits obj/<config>/<tfm>/<name>.GlobalUsings.g.cs. Implements [SCRIPT-FILEBASED-REFERENCES].
    private const string GlobalUsingsFileName = "SharpLsp.ImplicitUsings.g.cs";

    private static DocumentInfo BuildGlobalUsingsInfo(ProjectId projectId, string rootPath)
    {
        var source = string.Concat(
            ConsoleImplicitUsings.Select(ns => $"global using global::{ns};\n")
        );
        var directory = Path.GetDirectoryName(rootPath) ?? ".";
        return DocumentInfo.Create(
            DocumentId.CreateNewId(projectId),
            GlobalUsingsFileName,
            loader: TextLoader.From(
                TextAndVersion.Create(SourceText.From(source), VersionStamp.Create())
            ),
            filePath: Path.Combine(directory, GlobalUsingsFileName)
        );
    }

    // A Document's SourceCodeKind is per-document and defaults to Regular; the project's
    // parseOptions kind does not propagate to it. Without this a `.csx` document reports
    // "#load is only allowed in scripts". Implements [SCRIPT-CSX-OPTIONS].
    private static DocumentInfo BuildDocumentInfo(
        ProjectId projectId,
        ClosureFile file,
        ProjectlessKind kind
    )
    {
        return DocumentInfo.Create(
            DocumentId.CreateNewId(projectId),
            Path.GetFileName(file.Path),
            sourceCodeKind: kind == ProjectlessKind.Script
                ? SourceCodeKind.Script
                : SourceCodeKind.Regular,
            loader: TextLoader.From(
                TextAndVersion.Create(SourceText.From(file.Text), VersionStamp.Create())
            ),
            filePath: file.Path
        );
    }

    private static void LogClosure(ProjectlessKind kind, string rootPath, Closure closure)
    {
        Log.Information(
            "Loaded {Kind} '{Root}' with {FileCount} file(s) in the closure",
            kind,
            rootPath,
            closure.Files.Count
        );
        foreach (var issue in closure.Issues)
        {
            Log.Warning("Closure issue for {Root}: {Issue}", rootPath, issue);
        }
    }
}
