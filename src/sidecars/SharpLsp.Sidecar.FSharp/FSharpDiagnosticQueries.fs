/// Current compiler inputs and findings, computed only for the requested file.
/// Implements [DIAG-TRUTH-GUARANTEES], [DIAG-ARCHITECTURE-SALSA], [SCRIPT-FSX-DIAGNOSTICS].
module SharpLsp.Sidecar.FSharp.FSharpDiagnosticQueries

open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open SharpLsp.Sidecar.Common

[<NoComparison; NoEquality>]
type Context =
    { Workspace: FSharpWorkspace.FSharpWorkspaceState
      AnalyzersEnabled: bool
      Analyzers: FSharpAnalyzers.AnalyzerConfig
      NotifyScopeChanged: bool -> CancellationToken -> Task<bool> }

/// Request-local values; the workspace retains only compiler input options.
[<NoComparison; NoEquality>]
type private Snapshot =
    { Diagnostics: FSharpDiagnostic array
      CheckedFile: (FSharpParseFileResults * FSharpCheckFileResults * string) option
      ScopeChanged: bool }

/// A script closure ends with its root; ordinary projects keep their existing owner.
let private scriptInput (state: FSharpWorkspace.FSharpWorkspaceState) filePath =
    match state.ProjectOptions with
    | Some options when state.Projects.IsEmpty && options.UseScriptResolutionRules ->
        options.SourceFiles |> Array.tryLast |> Option.map (fun root -> root, true, Some options)
    | _ when FSharpProjectLoading.isScriptPath filePath && (FSharpWorkspace.projectOf state filePath).IsNone ->
        Some(filePath, false, None)
    | _ -> None

/// Changed source membership needs another metadata pull, including removals.
let private scopeChanged previous (current: FSharpProjectOptions) =
    previous |> Option.exists (fun (old: FSharpProjectOptions) ->
        old.SourceFiles.Length <> current.SourceFiles.Length
        || Array.exists2 (fun left right -> not (NativePaths.AreEqual(left, right))) old.SourceFiles current.SourceFiles)

/// Re-resolve directives from current editor text; retain no diagnostic arrays.
/// [HOVER-FSHARP-OVERLAY]
let private scriptOptions (state: FSharpWorkspace.FSharpWorkspaceState) (root, persist, previous) ct =
    task {
        let! options, diagnostics, sourceLength = FSharpProjectLoading.scriptOptionsFromEditor state.Checker state.Overlays root ct
        Serilog.Log.Debug("Script compiler inputs resolved: {SourceLength}, {DiagnosticCount}, {SourceFileCount}",
            sourceLength, diagnostics.Length, options.SourceFiles.Length)
        let changed = persist && scopeChanged previous options
        if persist then state.ProjectOptions <- Some options
        return options, diagnostics, changed
    }

/// A semantic request must never observe references from the previous editor text.
/// [HOVER-FSHARP-OVERLAY] [SCRIPT-FSX-OPTIONS]
let refreshInputs state filePath ct =
    task {
        match scriptInput state filePath with
        | None -> return false
        | Some input ->
            let! _, _, changed = scriptOptions state input ct
            return changed
    }

/// Findings from loaded sources keep their owner; global setup errors use the root.
let private ownedBy filePath root options (diagnostic: FSharpDiagnostic) =
    NativePaths.AreEqual(diagnostic.FileName, filePath)
    || (NativePaths.AreEqual(filePath, root) && FSharpProjectDiagnostics.belongsToProject options diagnostic)

/// Preserve distinct compiler findings at their actual owning source.
let private ownedFindings filePath root options (raw: FSharpDiagnostic array) =
    let owned = raw |> Array.filter (ownedBy filePath root options)
                    |> Array.distinctBy FSharpProjectDiagnostics.diagnosticIdentity
    Serilog.Log.Debug("Script compiler findings mapped: {RawCount}, {OwnedCount}, {RootRequested}",
        raw.Length, owned.Length, NativePaths.AreEqual(filePath, root))
    owned

/// Preserve distinct findings from the compiler's option, parse and check streams.
let private scriptFindings filePath root options setup (parsed: FSharpParseFileResults) checkedFile =
    let checkedDiagnostics = checkedFile |> Option.map (fun (_, check: FSharpCheckFileResults, _) -> check.Diagnostics) |> Option.defaultValue [||]
    Array.concat [ Array.ofList setup; parsed.Diagnostics; checkedDiagnostics ]
    |> ownedFindings filePath root options

/// Compiler input failures must be resolved before semantic analysis is trustworthy.
let private isError (diagnostic: FSharpDiagnostic) =
    diagnostic.Severity = FSharpDiagnosticSeverity.Error

/// Use the same raw compiler check as existing semantic queries.
let private checkedSnapshot state filePath root (options, setup, changed) ct =
    task {
        let! parsed, answer, source = FSharpWorkspace.parseAndCheckOnceWithCancellation state filePath options ct
        let checkedFile = match answer with FSharpCheckFileAnswer.Succeeded check -> Some(parsed, check, source) | FSharpCheckFileAnswer.Aborted -> None
        let diagnostics = scriptFindings filePath root options setup parsed checkedFile
        let failed = diagnostics |> Array.exists isError
        return if checkedFile.IsNone && not failed then Error "The script compiler check did not complete."
               else Ok { Diagnostics = diagnostics; CheckedFile = checkedFile; ScopeChanged = changed }
    }

/// Report actual reference-resolution failures without cascading compiler guesses.
let private scriptSnapshot state filePath ((root, _, _) as input) ct =
    task {
        let! ((options, setup, changed) as resolved) = scriptOptions state input ct
        if setup |> List.exists isError then
            return Ok { Diagnostics = ownedFindings filePath root options (Array.ofList setup)
                        CheckedFile = None; ScopeChanged = changed }
        else return! checkedSnapshot state filePath root resolved ct
    }

/// [DIAG-TRUTH-GUARANTEES]: an unavailable check never becomes a clean snapshot.
let private projectSnapshot state filePath ct =
    task {
        let failure = FSharpWorkspace.optionsFor state filePath |> Option.bind (FSharpDiagnosticInputs.failure state)
        match failure with
        | Some reason -> return Error reason
        | None ->
            match! FSharpWorkspace.checkFileWithParseWithCancellation state filePath ct with
            | None -> return Error "The F# compiler check did not complete."
            | Some(parsed, check, source) ->
                return Ok { Diagnostics = check.Diagnostics |> Array.filter (fun diagnostic -> NativePaths.AreEqual(diagnostic.FileName, filePath))
                            CheckedFile = Some(parsed, check, source); ScopeChanged = false }
    }

/// Select compiler inputs without duplicating the actual per-file FCS check.
let private snapshot state filePath ct =
    task {
        match scriptInput state filePath with
        | Some input ->
            Serilog.Log.Debug("File diagnostic compiler input: {Script}", true)
            return! scriptSnapshot state filePath input ct
        | None ->
            Serilog.Log.Debug("File diagnostic compiler input: {Script}", false)
            return! projectSnapshot state filePath ct
    }

/// File-local analyzers retain their existing opt-out and checked source.
/// [ANALYZERS-FSAC-UNUSED-OPEN] [ANALYZERS-FSAC-SIMPLIFY-NAME]
let private fileAnalyzers context checkedFile =
    match context.AnalyzersEnabled, checkedFile with
    | true, Some(_, check, source) -> FSharpAnalyzers.fileAnalyzerDiagnostics check source
    | _ -> async { return [] }

/// The same project scope and monorepo policy govern dead-code findings.
/// [ANALYZERS-DEADCODE-SEVERITY]
let private projectAnalyzers context filePath ct =
    if context.AnalyzersEnabled then
        FSharpAnalyzers.deadCodeInFile context.Workspace context.Analyzers filePath ct
    else
        Task.FromResult []

/// One mapper supplies both real source locations and root-owned setup failures.
let private findings context filePath data ct =
    task {
        let compiler = data.Diagnostics |> Array.map (fun diagnostic ->
            FSharpProjectDiagnostics.compilerDiagnostic filePath (not (NativePaths.AreEqual(diagnostic.FileName, filePath))) diagnostic)
        let! local = Async.StartAsTask(fileAnalyzers context data.CheckedFile, cancellationToken = ct)
        let! project = if data.CheckedFile.IsSome then projectAnalyzers context filePath ct else Task.FromResult([])
        let! lint =
            match context.AnalyzersEnabled, data.CheckedFile with
            | true, Some checkedFile -> FSharpLintDiagnostics.get filePath checkedFile ct
            | _ -> Task.FromResult []
        return Array.concat [ compiler; Array.ofList local; Array.ofList project; Array.ofList lint ]
    }

/// Decode/error handling remains in the canonical IPC helper; computation has no cache.
let get (context: Context) requestPath ct =
    task {
        try
            // Preserve the compiler project's path spelling. [REFERENCES-FSHARP-FIND]
            let filePath = FSharpWorkspace.projectFilePath context.Workspace requestPath
            let! current = snapshot context.Workspace filePath ct
            match current with
            | Error reason -> return Error reason
            | Ok data ->
                let! notified = context.NotifyScopeChanged data.ScopeChanged ct
                if not notified then return Error "F# diagnostic invalidation delivery failed."
                else
                    let! diagnostics = findings context filePath data ct
                    return Ok diagnostics
        with ex -> return Error ex.Message
    }
