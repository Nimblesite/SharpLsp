using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Text;
using Outcome;
using Serilog;
using SharpLsp.Sidecar.Common;
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

    // Tier-2 notice codes. The two states are separate codes, never one code plus
    // prose, because the editor host polls diagnostics until the restore settles and
    // must not parse message text to decide. Implements
    // [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    private const string RestoreDegradedCode = "SLSPC0001";
    private const string RestorePendingCode = "SLSPC0002";

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
        return NativePaths.HasExtension(path, ".cs") ? ProjectlessKind.FileBasedApp
            : NativePaths.HasExtension(path, ".csx") ? ProjectlessKind.Script
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

        var closure = await ExpandAsync(kind, path, live: null, ct).ConfigureAwait(false);
        return closure.Files.Count == 0
            ? VoidResult.Failure($"Could not read '{path}'.")
            : await LoadClosureAsync(kind, path, closure, ct).ConfigureAwait(false);
    }

    private static Task<Closure> ExpandAsync(
        ProjectlessKind kind,
        string rootPath,
        LiveText? live,
        CancellationToken ct
    )
    {
        return kind == ProjectlessKind.Script
            ? DocumentClosure.ExpandScriptAsync(rootPath, live, ct)
            : DocumentClosure.ExpandFileBasedAsync(rootPath, live, ct);
    }

    private async Task<VoidResult> LoadClosureAsync(
        ProjectlessKind kind,
        string rootPath,
        Closure closure,
        CancellationToken ct
    )
    {
        _adhocWorkspace ??= new AdhocWorkspace();
        await PrepareProjectlessRootAsync(rootPath, ct).ConfigureAwait(false);

        var projectInfo = BuildProjectInfo(kind, rootPath);

        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // ADDED TO the live solution, never read back out of _adhocWorkspace.
            //
            // `_solution` is the only authority on what is loaded. It accumulates
            // everything that happens after a root opens: live document text, closure
            // reconciliation, and the tier-1 metadata references a settled restore
            // swaps in. `_adhocWorkspace.CurrentSolution` accumulates none of that —
            // it forks away the first time a document's text changes.
            //
            // Publishing `_adhocWorkspace.CurrentSolution` here therefore did not open
            // a root, it RESET every root: each new file-based app discarded the
            // resolved `#:package` references of every app already open, which went
            // red with CS0246 about 20ms after the neighbour loaded and stayed red
            // until something happened to re-resolve them. Two roots were not isolated
            // but serially destructive — only the most recently opened one had a valid
            // package context. Issue #294, [SCRIPT-FILEBASED-REFERENCES-MSBUILD].
            _solution = AddProjectlessRoot(kind, rootPath, projectInfo, closure);
            ReplayPendingTextEdits();
            // Under the same lock as the solution publication: a diagnostics state
            // capture must never see the tier-2 solution without its pending notice.
            // The didChange path already starts resolution under this lock; the open
            // path must match it. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            StartPackageResolution(kind, rootPath, projectInfo.Id, closure);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }

        LogClosure(kind, rootPath, closure);
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    /// <summary>
    /// Add one projectless root's project and closure documents to the live solution.
    /// </summary>
    /// <remarks>
    /// The baseline is <c>_solution</c> whenever it is one of this adhoc workspace's
    /// own forks, so roots accumulate instead of replacing each other. Implements
    /// [SCRIPT-CLOSURE].
    /// </remarks>
    private Solution AddProjectlessRoot(
        ProjectlessKind kind,
        string rootPath,
        ProjectInfo projectInfo,
        Closure closure
    )
    {
        var next = ProjectlessBaseline().AddProject(projectInfo);
        foreach (var file in closure.Files)
        {
            next = next.AddDocument(BuildDocumentInfo(projectInfo.Id, file, kind));
        }

        return kind == ProjectlessKind.FileBasedApp
            ? next.AddDocument(BuildGlobalUsingsInfo(projectInfo.Id, rootPath))
            : next;
    }

    /// <summary>The solution a newly opened projectless root is added to.</summary>
    /// <remarks>
    /// Projectless projects must descend from <c>_adhocWorkspace</c>: a live edit is
    /// routed to closure re-expansion by testing its document's
    /// <c>Solution.Workspace</c> for <c>AdhocWorkspace</c>, so a root forked off an
    /// MSBuild solution would silently stop re-expanding its own closure. When a
    /// previously loaded <c>.sln</c> still owns <c>_solution</c>, this starts a fresh
    /// adhoc fork rather than grafting a file-based app onto it.
    /// </remarks>
    private Solution ProjectlessBaseline()
    {
        return _solution is not null && ReferenceEquals(_solution.Workspace, _adhocWorkspace)
            ? _solution
            : _adhocWorkspace!.CurrentSolution;
    }

    /// <summary>
    /// Re-expand the closure a live edit belongs to and reconcile the project with it.
    /// </summary>
    /// <remarks>
    /// The closure is owned by the project's ROOT file, never by whichever member was edited.
    /// Expanding from an <c>#:include</c>d file instead would produce a closure that does not
    /// contain the real root, and the reconciliation below would then prune the root out of its
    /// own project, leaving the document the user is editing unserved. Implements
    /// [SCRIPT-CLOSURE], [SCRIPT-RELOAD].
    /// </remarks>
    internal async Task<VoidResult> UpdateProjectlessClosureAsync(
        Document document,
        string newText,
        CancellationToken ct
    )
    {
        if (_solution is null)
        {
            return VoidResult.Failure("No active solution.");
        }

        var currentProject = _solution.GetProject(document.Project.Id);
        if (currentProject is null)
        {
            return VoidResult.Failure("Project not found.");
        }

        var rootPath = ProjectRootPath(currentProject, document.FilePath!);
        var kind = Classify(rootPath);
        var live = new LiveText(document.FilePath!, newText);
        var closure = await ExpandAsync(kind, rootPath, live, ct).ConfigureAwait(false);

        _solution = ReconcileClosureDocuments(currentProject, document.FilePath!, closure, kind);
        return RebuildProjectModel(kind, rootPath, currentProject.Id, closure);
    }

    /// <summary>
    /// Add closure members the project is missing and drop the ones it no longer owns. The file
    /// being edited is never dropped: it stays served until the host closes it.
    /// </summary>
    private Solution ReconcileClosureDocuments(
        Project currentProject,
        string editedPath,
        Closure closure,
        ProjectlessKind kind
    )
    {
        var currentDocIds = currentProject.Documents.ToDictionary(
            document => document.FilePath!,
            document => document.Id,
            NativePaths.Comparer
        );
        var closurePaths = closure.Files.Select(file => file.Path).ToHashSet(NativePaths.Comparer);
        var next = _solution!;

        foreach (var file in closure.Files.Where(file => !currentDocIds.ContainsKey(file.Path)))
        {
            next = next.AddDocument(BuildDocumentInfo(currentProject.Id, file, kind));
        }

        foreach (var (path, documentId) in currentDocIds)
        {
            next = IsOrphanedClosureDocument(path, editedPath, closurePaths)
                ? next.RemoveDocument(documentId)
                : next;
        }

        return next;
    }

    private static bool IsOrphanedClosureDocument(
        string path,
        string editedPath,
        HashSet<string> closurePaths
    )
    {
        return !NativePaths.SameName(path, GlobalUsingsFileName)
            && !closurePaths.Contains(path)
            && !NativePaths.Comparer.Equals(path, editedPath);
    }

    /// <summary>
    /// Reset the project to tier-2 BCL references and restart package resolution, but only when
    /// the directives or packages actually changed. Implements
    /// [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    /// </summary>
    private VoidResult RebuildProjectModel(
        ProjectlessKind kind,
        string rootPath,
        ProjectId projectId,
        Closure closure
    )
    {
        var project = _solution!.GetProject(projectId);
        if (project is null || !ProjectModelChanged(rootPath, closure))
        {
            return new VoidResult.Ok<Unit, string>(Unit.Value);
        }

        var isScript = kind == ProjectlessKind.Script;
        _solution = project
            .WithMetadataReferences(BasicReferences())
            .WithCompilationOptions(BuildCompilationOptions(isScript, rootPath))
            .WithParseOptions(BuildParseOptions(isScript))
            .Solution;
        StartPackageResolution(kind, rootPath, projectId, closure);
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    /// <summary>
    /// Append the tier-2 notice captured by <c>CaptureDiagnosticsStateAsync</c>. The
    /// notice is a snapshot taken WITH the document — re-reading the live map here
    /// would reintroduce the torn answer this pairing exists to prevent.
    /// Implements [SCRIPT-FILEBASED-REFERENCES-FALLBACK].
    /// </summary>
    private static void AppendDegradation(
        string filePath,
        ProjectlessDegradation? degradation,
        List<DiagnosticResult> diagnostics
    )
    {
        if (degradation is not null)
        {
            diagnostics.Add(DegradationDiagnostic(filePath, degradation));
        }
    }

    private static DiagnosticResult DegradationDiagnostic(
        string filePath,
        ProjectlessDegradation degradation
    )
    {
        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = 0,
            StartCharacter = 0,
            EndLine = 0,
            EndCharacter = 1,
            Message =
                $"File-based package restore degraded to BCL-only references: {degradation.Reason}",
            Severity = "Info",
            Code = degradation.IsPending ? RestorePendingCode : RestoreDegradedCode,
        };
    }

    private static ProjectInfo BuildProjectInfo(ProjectlessKind kind, string rootPath)
    {
        var name = NativePaths.StemOf(rootPath);
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
            // Tier 2 is immediate and BCL-only. A background synthesized MSBuild project
            // atomically replaces this complete set after restore. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            metadataReferences: BasicReferences()
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

        var baseDirectory = NativePaths.DirectoryOf(rootPath);
        return options.WithSourceReferenceResolver(
            new SourceFileResolver([], baseDirectory.Length == 0 ? null : baseDirectory)
        );
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
        return DocumentInfo.Create(
            DocumentId.CreateNewId(projectId),
            GlobalUsingsFileName,
            loader: TextLoader.From(
                TextAndVersion.Create(SourceText.From(source), VersionStamp.Create())
            ),
            filePath: NativePaths.Resolve(NativePaths.DirectoryOf(rootPath), GlobalUsingsFileName)
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
            NativePaths.NameOf(file.Path),
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
