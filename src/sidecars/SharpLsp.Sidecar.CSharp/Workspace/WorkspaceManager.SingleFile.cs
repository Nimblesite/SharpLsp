using System.Collections.Immutable;
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
        await PrepareProjectlessRootAsync(rootPath, ct).ConfigureAwait(false);

        var project = _adhocWorkspace.AddProject(BuildProjectInfo(kind, rootPath));
        foreach (var file in closure.Files)
        {
            var docInfo = BuildDocumentInfo(project.Id, file, kind);
            _ = _adhocWorkspace.AddDocument(docInfo);
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

        StartPackageResolution(kind, rootPath, project.Id, closure);
        LogClosure(kind, rootPath, closure);
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    private async Task PrepareProjectlessRootAsync(string rootPath, CancellationToken ct)
    {
        rootPath = NormalizeRootPath(rootPath);
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _ = _packageResolutionGenerations.TryRemove(rootPath, out _);
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
            _ = _documentPackages.Remove(rootPath);
            _ = _documentDirectives.Remove(rootPath);
            RemoveExistingProjectlessRoot(rootPath);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    private void RemoveExistingProjectlessRoot(string rootPath)
    {
        var project = _adhocWorkspace?.CurrentSolution.Projects.FirstOrDefault(candidate =>
            candidate.FilePath is not null
            && string.Equals(
                NormalizeRootPath(candidate.FilePath),
                rootPath,
                StringComparison.OrdinalIgnoreCase
            )
        );
        if (project is not null)
        {
            var nextSolution = _adhocWorkspace!.CurrentSolution.RemoveProject(project.Id);
            if (!_adhocWorkspace.TryApplyChanges(nextSolution))
            {
                Log.Warning("Could not replace reopened projectless root {Root}", rootPath);
            }
        }
    }

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

        var kind = Classify(document.FilePath!);
        var closure =
            kind == ProjectlessKind.Script
                ? await DocumentClosure
                    .ExpandScriptAsync(document.FilePath!, newText, ct)
                    .ConfigureAwait(false)
                : await DocumentClosure
                    .ExpandFileBasedAsync(document.FilePath!, newText, ct)
                    .ConfigureAwait(false);

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

        var rootPath = ProjectRootPath(currentProject, document.FilePath!);
        var projectModelChanged = ProjectModelChanged(rootPath, closure);
        if (projectModelChanged)
        {
            var updatedProject = nextSolution
                .GetProject(currentProject.Id)!
                .WithMetadataReferences(BasicReferences())
                .WithCompilationOptions(
                    BuildCompilationOptions(kind == ProjectlessKind.Script, rootPath)
                )
                .WithParseOptions(BuildParseOptions(kind == ProjectlessKind.Script));
            nextSolution = updatedProject.Solution;
        }

        _solution = nextSolution;
        if (projectModelChanged)
        {
            StartPackageResolution(kind, rootPath, currentProject.Id, closure);
        }
        return new VoidResult.Ok<Unit, string>(Unit.Value);
    }

    private bool ProjectModelChanged(string rootPath, Closure closure)
    {
        return !_documentPackages.TryGetValue(rootPath, out var packages)
            || !closure.Packages.SequenceEqual(packages)
            || !_documentDirectives.TryGetValue(rootPath, out var directives)
            || !closure.Directives.SequenceEqual(directives);
    }

    private void StartPackageResolution(
        ProjectlessKind kind,
        string rootPath,
        ProjectId projectId,
        Closure closure
    )
    {
        rootPath = NormalizeRootPath(rootPath);
        var generation = Interlocked.Increment(ref _nextPackageResolutionGeneration);
        _packageResolutionGenerations[rootPath] = generation;
        _documentPackages[rootPath] = closure.Packages;
        _documentDirectives[rootPath] = closure.Directives;
        if (kind != ProjectlessKind.FileBasedApp)
        {
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
            return;
        }

        _projectlessDegradations[rootPath] = PendingEvaluationReason(closure.Packages);
        _ = ResolveAndUpgradeAsync(rootPath, projectId, closure, generation);
    }

    private async Task ResolveAndUpgradeAsync(
        string rootPath,
        ProjectId projectId,
        Closure closure,
        long generation
    )
    {
        var ct = _packageResolutionCancellation.Token;
        try
        {
            var resolution = await FileBasedPackageResolver
                .ResolveAsync(closure, rootPath, ct)
                .ConfigureAwait(false);
            if (resolution.IsError)
            {
                TrackPackageFailure(rootPath, generation, !resolution ?? "Package restore failed.");
                return;
            }

            var project = resolution.Match(value => value, _ => null!);
            await ApplyPackageReferencesAsync(rootPath, projectId, project, generation, ct)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            Log.Debug("Cancelled file-based package resolution for {Root}", rootPath);
        }
        catch (Exception exception)
        {
            TrackPackageFailure(rootPath, generation, exception.Message);
        }
    }

    private async Task ApplyPackageReferencesAsync(
        string rootPath,
        ProjectId projectId,
        ResolvedFileBasedProject resolved,
        long generation,
        CancellationToken ct
    )
    {
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!IsCurrentPackageResolution(rootPath, generation) || _solution is null)
            {
                return;
            }

            var project = _solution.GetProject(projectId);
            if (project is null)
            {
                return;
            }

            var nextProject = project
                .WithMetadataReferences(resolved.References)
                .WithCompilationOptions(resolved.CompilationOptions)
                .WithParseOptions(TierOneParseOptions(resolved.ParseOptions));
            var nextSolution = nextProject.Solution;
            ApplyAdhocChanges(nextSolution);
            _solution = nextSolution;
            _ = _projectlessDegradations.TryRemove(rootPath, out _);
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
    }

    private void ApplyAdhocChanges(Solution nextSolution)
    {
        if (_adhocWorkspace is not null && !_adhocWorkspace.TryApplyChanges(nextSolution))
        {
            Log.Warning("Could not apply restored file-based package references");
        }
    }

    private void TrackPackageFailure(string rootPath, long generation, string reason)
    {
        if (!IsCurrentPackageResolution(rootPath, generation))
        {
            return;
        }

        _projectlessDegradations[rootPath] = reason;
        Log.Warning("File-based package restore degraded to BCL references: {Reason}", reason);
    }

    private bool IsCurrentPackageResolution(string rootPath, long generation)
    {
        return _packageResolutionGenerations.TryGetValue(rootPath, out var current)
            && current == generation;
    }

    private void AppendProjectlessDegradation(
        Document document,
        string filePath,
        List<DiagnosticResult> diagnostics
    )
    {
        var rootPath = ProjectRootPath(document.Project, filePath);
        if (!_projectlessDegradations.TryGetValue(rootPath, out var reason))
        {
            return;
        }

        diagnostics.Add(DegradationDiagnostic(filePath, reason));
    }

    private static DiagnosticResult DegradationDiagnostic(string filePath, string reason)
    {
        return new DiagnosticResult
        {
            FilePath = filePath,
            StartLine = 0,
            StartCharacter = 0,
            EndLine = 0,
            EndCharacter = 1,
            Message = $"File-based package restore degraded to BCL-only references: {reason}",
            Severity = "Info",
            Code = "SLSPC0001",
        };
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
            // Tier 2 is immediate and BCL-only. A background synthesized MSBuild project
            // atomically replaces this complete set after restore. [SCRIPT-FILEBASED-REFERENCES-FALLBACK]
            metadataReferences: BasicReferences()
        );
    }

    private static ImmutableArray<PortableExecutableReference> BasicReferences()
    {
        return Basic.Reference.Assemblies.Net100.References.All;
    }

    private static string ProjectRootPath(Project project, string fallback)
    {
        return NormalizeRootPath(project.FilePath ?? fallback);
    }

    private static string NormalizeRootPath(string path)
    {
        return Path.GetFullPath(path);
    }

    private static string DescribePackages(IEnumerable<PackageRef> packages)
    {
        return string.Join(
            ", ",
            packages.Select(package =>
                string.IsNullOrEmpty(package.Version)
                    ? package.Name
                    : $"{package.Name}@{package.Version}"
            )
        );
    }

    private static string PendingEvaluationReason(IReadOnlyList<PackageRef> packages)
    {
        return packages.Count == 0
            ? "MSBuild evaluation is pending."
            : $"Restore pending for {DescribePackages(packages)}.";
    }

    private static CSharpParseOptions TierOneParseOptions(CSharpParseOptions options)
    {
        return options
            .WithKind(SourceCodeKind.Regular)
            .WithFeatures([new KeyValuePair<string, string>("FileBasedProgram", "true")]);
    }

    private async Task ResetProjectlessStateAsync(CancellationToken ct)
    {
        await _solutionMutationLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _packageResolutionGenerations.Clear();
            _documentPackages.Clear();
            _documentDirectives.Clear();
            _projectlessDegradations.Clear();
            await _packageResolutionCancellation.CancelAsync().ConfigureAwait(false);
            _packageResolutionCancellation.Dispose();
            _packageResolutionCancellation = new CancellationTokenSource();
            _adhocWorkspace?.Dispose();
            _adhocWorkspace = null;
            _isProjectlessDirectory = false;
        }
        finally
        {
            _ = _solutionMutationLock.Release();
        }
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
