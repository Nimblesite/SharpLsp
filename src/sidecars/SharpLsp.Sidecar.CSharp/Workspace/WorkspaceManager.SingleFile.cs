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
            ? DocumentClosure.ExpandScriptAsync(path, ct)
            : DocumentClosure.ExpandFileBasedAsync(path, ct);
    }

    private async Task<VoidResult> LoadClosureAsync(
        ProjectlessKind kind,
        string rootPath,
        Closure closure,
        CancellationToken ct
    )
    {
        _adhocWorkspace ??= new AdhocWorkspace();

        var project = _adhocWorkspace.AddProject(BuildProjectInfo(kind, rootPath));
        foreach (var file in closure.Files)
        {
            _ = _adhocWorkspace.AddDocument(BuildDocumentInfo(project.Id, file, kind));
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

    private static ProjectInfo BuildProjectInfo(ProjectlessKind kind, string rootPath)
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
            // Tier 2 reference resolution: in-memory BCL only. `#:package` symbols do not bind
            // until the synthesized-project path lands. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            metadataReferences: Basic.Reference.Assemblies.Net100.References.All
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
