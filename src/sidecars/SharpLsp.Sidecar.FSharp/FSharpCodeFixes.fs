/// F# code fixes via FSharp.Compiler.Service diagnostics.
/// Maps FCS diagnostic codes to concrete text edits.
module SharpLsp.Sidecar.FSharp.FSharpCodeFixes

open System
open System.Collections.Concurrent
open System.Threading
open System.Threading.Tasks
open FSharp.Compiler.CodeAnalysis
open FSharp.Compiler.Diagnostics
open FSharp.Compiler.Text
open Serilog
open SharpLsp.Sidecar.Common.Messages

// ── Types ────────────────────────────────────────────────────────

[<NoComparison; NoEquality>]
type CodeActionItem =
    { Id: int
      Title: string
      Kind: string
      IsPreferred: bool
      /// The reference added before resolve; null for a plain edit. [REFACTOR-IMPORT-REFERENCE]
      Reference: ReferenceImport | null
      /// The fix's stable batch identity ([FIXALL-SCOPES], GitHub #577); null
      /// when the fix runs only on its one occurrence.
      FixKey: string | null
      /// The scopes ("document", "project", "solution") the fix batch-runs
      /// at; null with FixKey. [FIXALL-SCOPES]
      FixAllScopes: string list | null }

/// The stable fix-all identities of the batch-capable F# fixes — one per row
/// of [FIXALL-RULES-TABLE], data the host's `Fix all: …` menu reads.
module FixAllKeys =
    /// Remove unused open — SLSPF0102. [FIXALL-RULES-TABLE]
    [<Literal>]
    let RemoveUnusedOpen = "SLSPF0102"

    /// Simplify name — SLSPF0103. [FIXALL-RULES-TABLE]
    [<Literal>]
    let SimplifyName = "SLSPF0103"

    /// Remove unused declaration — SLSPF0101. [FIXALL-RULES-TABLE]
    [<Literal>]
    let RemoveUnusedDeclaration = "SLSPF0101"

    /// Prefix unused value with `_` — FS1182. [FIXALL-RULES-TABLE]
    [<Literal>]
    let PrefixUnusedValue = "FS1182"

    /// Add `new` for IDisposable — FS0760. [FIXALL-RULES-TABLE]
    [<Literal>]
    let AddNewForDisposable = "FS0760"

    /// Every batch-capable fix runs at these three scopes. [FIXALL-SCOPES]
    let scopes: string list = [ "document"; "project"; "solution" ]

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

/// The wire-shaped edit of one raw edit (0-based LSP coordinates).
let ofRawEdit (e: FSharpCodeActions.RawEdit) : TextEdit =
    { StartLine = e.StartLine
      StartCharacter = e.StartCharacter
      EndLine = e.EndLine
      EndCharacter = e.EndCharacter
      NewText = e.NewText }

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
      IsPreferred = isPreferred
      Reference = null
      FixKey = null
      FixAllScopes = null }

/// One offered action stamped with its fix's batch identity and scopes, so the
/// host can offer `Fix all: …` for it. [FIXALL-SCOPES] (GitHub #577)
let private asFixAll (fixKey: string) (item: CodeActionItem) : CodeActionItem =
    { item with
        FixKey = fixKey
        FixAllScopes = FixAllKeys.scopes }

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
            |> List.map (fun (fp, edits) -> { FilePath = fp; Edits = edits |> List.map ofRawEdit }) }
    cacheAction state action.Title action.Kind action.IsPreferred edit

let private wrapImportAction fixKey state (action, reference) =
    { wrapGeneratedAction state action with
        Reference = reference
        FixKey = fixKey |> Option.toObj
        FixAllScopes = match fixKey with Some _ -> FixAllKeys.scopes | None -> null }

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
/// and these fixes are always computed from the same FCS results. Each carries
/// its batch identity for the host's fix-all menu. [FIXALL-SCOPES]
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

        let unusedOpens =
            removeUnusedOpenActions filePath findings.UnusedOpens startLine endLine
            |> List.map (wrapGeneratedAction state >> asFixAll FixAllKeys.RemoveUnusedOpen)

        let simplified =
            simplifyNameActions filePath findings.SimplifiableNames startLine endLine
            |> List.map (wrapGeneratedAction state >> asFixAll FixAllKeys.SimplifyName)

        return unusedOpens @ simplified
    }

/// The diagnostics on the requested lines.
let private overlapping startLine endLine (diagnostics: FSharpDiagnostic array) =
    diagnostics
    |> Array.filter (fun diagnostic ->
        let range = diagnostic.Range
        overlapsRange (range.StartLine - 1) (range.EndLine - 1) startLine endLine)
    |> Array.toList

let private withoutReference actions : (FSharpCodeActions.GeneratedAction * ReferenceImport | null) list =
    actions |> List.map (fun action -> action, null)

let private nameActions workspace parseResults checkResults source filePath r =
    task {
        let imports = FSharpNameFixes.imports workspace parseResults checkResults source filePath r
        let! external =
            match imports, FSharpNameFixes.flaggedName source r with
            | [], Some name -> FSharpImportReferences.actions workspace parseResults source filePath r name
            | _ -> Task.FromResult []
        let own = imports @ FSharpNameFixes.typos parseResults checkResults source filePath r |> withoutReference
        let outside = external |> List.map (fun (action, reference) -> action, reference)
        return own @ outside
    }

/// The quick fixes one diagnostic offers, keyed by its number, each built from
/// FCS's ranges, declarations, AST or typed data — never its message text.
/// [ANALYZERS-FSAC-CODEFIX-COMPILER] [REFACTOR-IMPORT-FSHARP]
let private fixesFor workspace parseResults checkResults source filePath (diagnostic: FSharpDiagnostic) =
    let r = diagnostic.Range
    match diagnostic.ErrorNumber with
    | 39 -> nameActions workspace parseResults checkResults source filePath r
    | number ->
        (match number with
         | 1 -> FSharpConversionFixes.conversions source filePath diagnostic
         | 20 -> [ FSharpQuickFix.replace "Add '|> ignore'" true filePath (Range.mkRange r.FileName r.End r.End) " |> ignore" ]
         | 25 -> FSharpMatchFixes.wildcards parseResults filePath r
         | 26 -> [ FSharpQuickFix.replace "Remove redundant pattern case" false filePath (FSharpQuickFix.wholeLines r) "" ]
         | 760 -> FSharpNameFixes.addNew parseResults filePath r
         | 1182 -> FSharpNameFixes.unused source filePath r
         | _ -> [])
        |> withoutReference
        |> Task.FromResult

let private tryFixesFor workspace parseResults checkResults source filePath diagnostic =
    task {
        try
            return! fixesFor workspace parseResults checkResults source filePath diagnostic
        with ex ->
            // [REFACTOR-NEVER-SILENT] A failed provider is visible with its diagnostic id.
            Log.Warning(ex, "F# code-action provider failed for FS{DiagnosticNumber}", diagnostic.ErrorNumber)
            return []
    }

/// The batch identity a diagnostic's quick fix carries, when it has one.
/// [FIXALL-SCOPES]
let private fixKeyOf (number: int) : string option =
    match number with
    | 760 -> Some FixAllKeys.AddNewForDisposable
    | 1182 -> Some FixAllKeys.PrefixUnusedValue
    | _ -> None

let rec private collectDiagnosticActions workspace filePath source parseResults checkResults (diagnostics: FSharpDiagnostic list) =
    task {
        match diagnostics with
        | [] -> return []
        | diagnostic :: rest ->
            let key = fixKeyOf diagnostic.ErrorNumber
            let! current = tryFixesFor workspace parseResults checkResults source filePath diagnostic
            let! remaining = collectDiagnosticActions workspace filePath source parseResults checkResults rest
            return (current |> List.map (fun pair -> (pair, key))) @ remaining
    }

/// The quick fixes of the diagnostics on the requested lines, each offered once: FCS
/// reports an unresolved attribute twice, once per spelling, with the same fix.
let private diagnosticActions state workspace filePath source parseResults checkResults diagnostics =
    task {
        let! actions = collectDiagnosticActions workspace filePath source parseResults checkResults diagnostics
        return actions |> List.distinct |> List.map (fun ((action, reference), key) -> wrapImportAction key state (action, reference))
    }

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
                |> List.map (wrapGeneratedAction state >> asFixAll FixAllKeys.RemoveUnusedDeclaration)
    }

let private collectCodeActions
    state workspace analyzers filePath source parseResults (checkResults: FSharpCheckFileResults)
    startLine startCharacter endLine ct =
    task {
        let! diagnostics =
            overlapping startLine endLine checkResults.Diagnostics
            |> diagnosticActions state workspace filePath source parseResults checkResults
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
            Log.Warning(ex, "F# code-action provider failed while listing fixes")
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
