/// Compiler diagnostics that belong to the project rather than a user source.
/// Implements [DIAG-CATEGORIES-COMPILER] without retaining computed results.
module SharpLsp.Sidecar.FSharp.FSharpProjectDiagnostics

open System.Threading
open FSharp.Compiler.Diagnostics
open SharpLsp.Sidecar.Common
open SharpLsp.Sidecar.FSharp
open Serilog

/// The same compiler severity mapping is used for source and project reports.
let private severity (diagnostic: FSharpDiagnostic) =
    match diagnostic.Severity with
    | FSharpDiagnosticSeverity.Error -> "Error"
    | FSharpDiagnosticSeverity.Warning -> "Warning"
    | FSharpDiagnosticSeverity.Info -> "Info"
    | _ -> "Hint"

/// Global failures have a useful zero-length location on the owning project.
let private coordinates projectScope (diagnostic: FSharpDiagnostic) =
    let range = diagnostic.Range
    if projectScope then 0, 0, 0, 0
    else range.StartLine - 1, range.StartColumn, range.EndLine - 1, range.EndColumn

/// Map one compiler diagnostic through the canonical source/project mapper.
let compilerDiagnostic filePath projectScope (diagnostic: FSharpDiagnostic) : DiagnosticResult =
    let startLine, startCharacter, endLine, endCharacter = coordinates projectScope diagnostic
    { FilePath = filePath
      StartLine = startLine
      StartCharacter = startCharacter
      EndLine = endLine
      EndCharacter = endCharacter
      Message = diagnostic.Message
      Severity = severity diagnostic
      Code = $"FS{diagnostic.ErrorNumber:D4}" }

/// Source-file failures are answered by their existing document query, once.
let internal belongsToProject (options: FSharp.Compiler.CodeAnalysis.FSharpProjectOptions) (diagnostic: FSharpDiagnostic) =
    options.SourceFiles
    |> Array.exists (fun source -> NativePaths.AreEqual(source, diagnostic.FileName))
    |> not

/// Compiler setup failures are exposed by the first file's background check,
/// even when ParseAndCheckProject reports an empty diagnostic array.
let private configurationDiagnostics (state: FSharpWorkspace.FSharpWorkspaceState) (options: FSharp.Compiler.CodeAnalysis.FSharpProjectOptions) ct =
    task {
        match options.SourceFiles |> Array.tryHead with
        | None -> return [||]
        | Some source ->
            let! _, check = Async.StartAsTask(
                state.Checker.GetBackgroundCheckResultsForFileInProject(source, options),
                cancellationToken = ct)
            return check.Diagnostics |> Array.filter (belongsToProject options)
    }

/// Preserve distinct compiler findings while combining its diagnostic streams.
let internal diagnosticIdentity (diagnostic: FSharpDiagnostic) =
    let range = diagnostic.Range
    diagnostic.ErrorNumber, diagnostic.Severity, range, diagnostic.Message

/// All diagnostic APIs use the same wired project snapshot and honor cancellation.
let private checkProject (state: FSharpWorkspace.FSharpWorkspaceState) options ct =
    task {
        let _, optionDiagnostics = state.Checker.GetParsingOptionsFromProjectOptions options
        let! project = Async.StartAsTask(state.Checker.ParseAndCheckProject options, cancellationToken = ct)
        let! configuration = configurationDiagnostics state options ct
        return Array.concat [ Array.ofList optionDiagnostics; project.Diagnostics; configuration ]
               |> Array.distinctBy diagnosticIdentity
    }

/// Log compiler identity and counts without source content.
let private logResults (options: FSharp.Compiler.CodeAnalysis.FSharpProjectOptions) (diagnostics: FSharpDiagnostic array) =
    for diagnostic in diagnostics do
        let range = diagnostic.Range
        Log.Debug("Project compiler diagnostic {Code} SourceOwned={SourceOwned} StartLine={StartLine}",
            diagnostic.ErrorNumber, not (belongsToProject options diagnostic), range.StartLine)
    Log.Debug("Project compiler check completed with {DiagnosticCount} diagnostics and {OptionCount} options",
        diagnostics.Length, options.OtherOptions.Length)

/// Compile only the requested current project; unresolved owners remain errors.
let getDiagnostics (state: FSharpWorkspace.FSharpWorkspaceState) projectPath (ct: CancellationToken) =
    task {
        let owner = FSharpWorkspace.projectOptions state
                    |> List.tryFind (fun options -> NativePaths.AreEqual(options.ProjectFileName, projectPath))
        match owner with
        | None -> return Error "The requested compiler project is not loaded."
        | Some options ->
            let options = FSharpWorkspace.wired state options
            let! diagnostics = checkProject state options ct
            logResults options diagnostics
            return diagnostics
                   |> Array.filter (belongsToProject options)
                   |> Array.map (compilerDiagnostic options.ProjectFileName true)
                   |> Ok
    }
