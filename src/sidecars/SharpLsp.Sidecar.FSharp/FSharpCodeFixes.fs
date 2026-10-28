/// F# code fixes via FSharp.Compiler.Service diagnostics.
/// Maps FCS diagnostic codes to concrete text edits.
module SharpLsp.Sidecar.FSharp.FSharpCodeFixes

open System
open System.Collections.Concurrent
open System.Threading
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open Serilog

// ── Types ────────────────────────────────────────────────────────

[<NoComparison; NoEquality>]
type CodeActionItem =
    { Id: int
      Title: string
      Kind: string
      IsPreferred: bool }

[<NoComparison; NoEquality>]
type TextEdit =
    { StartLine: int
      StartCharacter: int
      EndLine: int
      EndCharacter: int
      NewText: string }

[<NoComparison; NoEquality>]
type DocumentEdit =
    { FilePath: string
      Edits: TextEdit list }

[<NoComparison; NoEquality>]
type WorkspaceEdit =
    { DocumentChanges: DocumentEdit list }

[<NoComparison; NoEquality>]
type CodeFixState =
    { PendingEdits: ConcurrentDictionary<int, WorkspaceEdit>
      mutable NextId: int }

/// Create a new code fix state for caching pending edits.
let createState () : CodeFixState =
    { PendingEdits = ConcurrentDictionary<int, WorkspaceEdit>()
      NextId = 0 }

// ── Helpers ──────────────────────────────────────────────────────

/// Allocate a unique action ID (thread-safe).
let private nextId (state: CodeFixState) =
    Interlocked.Increment(&state.NextId)

/// Cache a workspace edit and return a CodeActionItem.
let private cacheAction
    (state: CodeFixState)
    (title: string)
    (kind: string)
    (isPreferred: bool)
    (edit: WorkspaceEdit)
    : CodeActionItem =
    let id = nextId state
    state.PendingEdits[id] <- edit
    { Id = id
      Title = title
      Kind = kind
      IsPreferred = isPreferred }

/// Check if a diagnostic's range overlaps with the requested range.
let private overlapsRange
    (diagStartLine: int) (diagEndLine: int)
    (reqStartLine: int) (reqEndLine: int)
    : bool =
    diagStartLine <= reqEndLine && diagEndLine >= reqStartLine

/// Wrap a GeneratedAction from FSharpCodeActions into a cached CodeActionItem.
let private wrapGeneratedAction
    (state: CodeFixState)
    (action: FSharpCodeActions.GeneratedAction)
    : CodeActionItem =
    let edit =
        { DocumentChanges =
            action.Edits
            |> List.groupBy (fun e -> e.FilePath)
            |> List.map (fun (fp, edits) ->
                { FilePath = fp
                  Edits =
                    edits
                    |> List.map (fun e ->
                        { StartLine = e.StartLine
                          StartCharacter = e.StartCharacter
                          EndLine = e.EndLine
                          EndCharacter = e.EndCharacter
                          NewText = e.NewText }) }) }
    cacheAction state action.Title action.Kind action.IsPreferred edit

/// Collect type-informed code actions (union stubs, record stubs).
let private collectTypeInformedActions
    (state: CodeFixState)
    (filePath: string)
    (source: string)
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    (startLine: int)
    (startChar: int)
    : CodeActionItem list =
    [ FSharpCodeActions.tryGenerateUnionStubs checkResults parseResults source filePath startLine startChar
      FSharpCodeActions.tryGenerateRecordStubs checkResults parseResults source filePath startLine startChar ]
    |> List.choose id
    |> List.map (wrapGeneratedAction state)

// ── Analyzer-driven fixes (FSAC parity) ──────────────────────────

/// [ANALYZERS-FSAC-CODEFIX-UNUSED-OPEN] "Remove unused open" for each unused `open` range that
/// overlaps the requested range. Deletes the whole `open` line (start of its first
/// line through the start of the line after its last), mirroring FSAC's behaviour.
let private removeUnusedOpenActions filePath (unusedOpens: range list) startLine endLine =
    unusedOpens
    |> List.filter (fun r -> overlapsRange (r.StartLine - 1) (r.EndLine - 1) startLine endLine)
    |> List.map (fun r -> FSharpQuickFix.replace "Remove unused open" false filePath (FSharpQuickFix.wholeLines r) "")

/// [ANALYZERS-FSAC-CODEFIX-SIMPLIFY-NAME] "Simplify name" for each redundant qualifier that
/// overlaps the requested range. FCS reports `Range` as the unnecessary qualifier
/// prefix (including its trailing dot), so simplification deletes that span,
/// e.g. `System.DateTime.MinValue` → `DateTime.MinValue` when `System` is open.
let private simplifyNameActions filePath (names: (range * string) list) startLine endLine =
    names
    |> List.filter (fun (r, _) -> overlapsRange (r.StartLine - 1) (r.EndLine - 1) startLine endLine)
    |> List.map (fun (r, _relativeName) -> FSharpQuickFix.replace "Simplify name" false filePath r "")

/// Collect analyzer-driven fixes (unused-open removal, name simplification) from
/// the shared [FSharpLocalAnalysis] findings, so the always-on diagnostic hints
/// and these fixes are always computed from the same FCS results.
let private collectAnalyzerActions
    (state: CodeFixState)
    (filePath: string)
    (checkResults: FSharpCheckFileResults)
    (source: string)
    (startLine: int)
    (endLine: int)
    : Async<CodeActionItem list> =
    async {
        let! findings = FSharpLocalAnalysis.getFileAnalyzerFindings checkResults source

        return
            removeUnusedOpenActions filePath findings.UnusedOpens startLine endLine
            @ simplifyNameActions filePath findings.SimplifiableNames startLine endLine
            |> List.map (wrapGeneratedAction state)
    }

/// The diagnostics on the requested lines.
let private overlapping startLine endLine (diagnostics: FSharpDiagnostic array) =
    diagnostics
    |> Array.filter (fun diagnostic ->
        let range = diagnostic.Range
        overlapsRange (range.StartLine - 1) (range.EndLine - 1) startLine endLine)
    |> Array.toList

/// The quick fixes one diagnostic offers, keyed by its number, each built from
/// FCS's ranges, declarations, AST or typed data — never its message text.
/// [ANALYZERS-FSAC-CODEFIX-COMPILER]
let private fixesFor parseResults checkResults source filePath (diagnostic: FSharpDiagnostic) =
    let r = diagnostic.Range

    match diagnostic.ErrorNumber with
    | 1 -> FSharpConversionFixes.conversions source filePath diagnostic
    | 20 -> [ FSharpQuickFix.replace "Add '|> ignore'" true filePath (Range.mkRange r.FileName r.End r.End) " |> ignore" ]
    | 25 -> FSharpMatchFixes.wildcards parseResults filePath r
    | 26 -> [ FSharpQuickFix.replace "Remove redundant pattern case" false filePath (FSharpQuickFix.wholeLines r) "" ]
    | 39 -> FSharpNameFixes.opens parseResults source filePath r @ FSharpNameFixes.typos parseResults checkResults source filePath r
    | 760 -> FSharpNameFixes.addNew parseResults filePath r
    | 1182 -> FSharpNameFixes.unused source filePath r
    | _ -> []

let private diagnosticActions state filePath source parseResults checkResults (diagnostics: FSharpDiagnostic list) =
    diagnostics
    |> List.collect (fixesFor parseResults checkResults source filePath)
    |> List.map (wrapGeneratedAction state)

let private interfaceActions
    state filePath source
    (checkResults: FSharpCheckFileResults)
    (parseResults: FSharpParseFileResults)
    line character =
    async {
        let! generated =
            FSharpInterfaceStubs.tryGenerateInterfaceStub
                checkResults parseResults source filePath line character
        return generated |> Option.map (wrapGeneratedAction state >> List.singleton) |> Option.defaultValue []
    }

/// [ANALYZERS-DEADCODE-FIX] "Remove unused" for each dead declaration on the
/// requested lines, from the analyzer's own findings; none while `analyzers` is
/// off. The project-wide analysis runs only when a deletable declaration is named
/// on those lines, so the editor's lightbulb elsewhere costs nothing.
let private deadCodeActions state workspace analyzers filePath parseResults checkResults source startLine endLine ct =
    task {
        match analyzers, FSharpDeadCodeFixes.declaredOn parseResults startLine endLine with
        | None, _
        | _, [] -> return []
        | Some config, candidates ->
            let! dead = FSharpAnalyzers.deadCodeInFile workspace config filePath ct
            return
                dead
                |> List.choose (FSharpDeadCodeFixes.removal checkResults source filePath candidates)
                |> List.map (wrapGeneratedAction state)
    }

let private collectCodeActions
    state workspace analyzers filePath source parseResults (checkResults: FSharpCheckFileResults)
    startLine startCharacter endLine ct =
    task {
        let diagnostics =
            overlapping startLine endLine checkResults.Diagnostics
            |> diagnosticActions state filePath source parseResults checkResults
        let! dead =
            deadCodeActions state workspace analyzers filePath parseResults checkResults source startLine endLine ct
        let typed =
            collectTypeInformedActions
                state filePath source checkResults parseResults startLine startCharacter
        let! analyzed = collectAnalyzerActions state filePath checkResults source startLine endLine
        let! interfaces =
            interfaceActions state filePath source checkResults parseResults startLine startCharacter
        let pipes =
            FSharpPipeRefactoring.tryGenerateActions parseResults source filePath startLine startCharacter
            |> List.map (wrapGeneratedAction state)
        return diagnostics @ dead @ typed @ analyzed @ interfaces @ pipes
    }

let private getCodeActionsCore state workspace analyzers filePath startLine startCharacter endLine ct =
    task {
        try
            let! checkedFile = FSharpWorkspace.checkFileWithParse workspace filePath
            match checkedFile with
            | None -> return []
            | Some(parseResults, checkResults, source) ->
                return!
                    collectCodeActions
                        state workspace analyzers filePath source parseResults checkResults
                        startLine startCharacter endLine ct
        with ex ->
            Log.Debug(ex, "[F# CodeFixes] failed")
            return []
    }

/// Get all code actions for a file range. `analyzers` is the analyzer configuration
/// while the analyzers are on, whose findings offer their own fixes; None while off.
let getCodeActions
    (state: CodeFixState)
    (workspace: FSharpWorkspace.FSharpWorkspaceState)
    (analyzers: FSharpAnalyzers.AnalyzerConfig option)
    (filePath: string)
    (startLine: int)
    (startCharacter: int)
    (endLine: int)
    (_endCharacter: int)
    (ct: CancellationToken)
    =
    getCodeActionsCore state workspace analyzers filePath startLine startCharacter endLine ct

/// Resolve a cached code action by ID.
let resolveCodeAction (state: CodeFixState) (actionId: int) : WorkspaceEdit option =
    match state.PendingEdits.TryRemove(actionId) with
    | true, edit -> Some edit
    | false, _ -> None
